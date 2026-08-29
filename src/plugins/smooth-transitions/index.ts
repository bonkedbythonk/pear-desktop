import { t } from '@/i18n';
import { createPlugin } from '@/utils';

import type { MusicPlayer } from '@/types/music-player';

export type SmoothTransitionsPluginConfig = {
  enabled: boolean;
  /**
   * Fade the volume down before pausing and back up when resuming,
   * instead of an abrupt stop/start (like Spotify does).
   *
   * @default true
   */
  fadeOnPause: boolean;
  /**
   * Duration of the pause/resume fade, in milliseconds.
   *
   * @default 250
   */
  pauseFadeDuration: number;
  /**
   * Fade the volume down briefly before switching to the next/previous
   * song (when manually skipping), and back up once the new song starts.
   *
   * @default true
   */
  fadeOnSkip: boolean;
  /**
   * Duration of the skip fade, in milliseconds.
   *
   * @default 200
   */
  skipFadeDuration: number;
};

type Teardown = () => void;

type DebugState = {
  video: HTMLVideoElement | null;
  isFading: boolean;
  pauseFadeToken: number;
  skipFadeToken: number;
  gainReady: boolean;
  disabled: boolean;
};

type AudioCanPlayDetail = {
  audioContext: AudioContext;
  audioSource: MediaElementAudioSourceNode;
};

/**
 * Fades are driven exclusively by a Web Audio GainNode - never by
 * video.volume. This is deliberate: video.volume is a shared property that
 * other plugins can globally reinterpret (e.g. Exponential Volume replaces
 * HTMLMediaElement.prototype.volume's getter/setter with a cubic curve, on
 * every video element, transforming whatever anyone reads or writes there).
 * A GainNode lives one layer below that, in the Web Audio graph, so it's
 * completely unaffected by what any other plugin does to video.volume - the
 * two compose multiplicatively (video.volume x gain) without either needing
 * to know the other exists. Fading video.volume directly, as this plugin
 * used to, meant every fade was silently corrupted by whatever transform
 * another plugin applied to that property.
 *
 * The rest value is always 1 (no attenuation) - fades are relative dips on
 * top of whatever video.volume/other plugins/the user's slider already
 * dictates, never a stored "target volume" that could go stale.
 */
function createGainFader(
  gainNode: GainNode,
  audioContext: AudioContext,
  debug: DebugState,
) {
  let rampTimeout: number | null = null;

  const rampTo = (target: number, durationMs: number, onDone?: () => void) => {
    if (rampTimeout !== null) {
      window.clearTimeout(rampTimeout);
      rampTimeout = null;
    }
    const now = audioContext.currentTime;
    // Pin the actually-reached value before cancelling, otherwise
    // cancelScheduledValues can leave/jump to a stale target.
    gainNode.gain.cancelScheduledValues(now);
    gainNode.gain.setValueAtTime(gainNode.gain.value, now);
    const durationSec = durationMs / 1000;
    gainNode.gain.linearRampToValueAtTime(target, now + durationSec);
    debug.isFading = true;
    rampTimeout = window.setTimeout(() => {
      rampTimeout = null;
      debug.isFading = false;
      onDone?.();
    }, durationMs);
  };

  return {
    get: () => gainNode.gain.value,
    rampTo,
    dispose() {
      if (rampTimeout !== null) {
        window.clearTimeout(rampTimeout);
        rampTimeout = null;
      }
      debug.isFading = false;
    },
  };
}

type GainFader = ReturnType<typeof createGainFader>;

/**
 * Wraps video.pause()/play() directly (not the player API) since the
 * on-screen button and spacebar call the element methods, bypassing the
 * API. Skip buttons are intercepted, faded, then re-clicked with a bypass
 * flag so the app's own navigation logic still runs.
 */
function setupSmoothTransitions(
  video: HTMLVideoElement,
  api: MusicPlayer,
  getConfig: () => SmoothTransitionsPluginConfig | null,
  debug: DebugState,
  fader: GainFader,
): Teardown {
  debug.video = video;

  // --- Pause / resume ---
  const originalVideoPause = video.pause.bind(video);
  const originalVideoPlay = video.play.bind(video);
  let pauseFadeToken = 0;

  // The spec has .pause() flip `paused` to true synchronously, but our
  // fade delays the real pause() call until the fade finishes - so any
  // code reading video.paused right after calling pause() (e.g. the
  // on-screen button's own icon/state logic) would see stale "still
  // playing" for the whole fade. Under rapid clicking that desyncs the
  // button from reality until it stops responding correctly. Shadowing
  // `paused` to report intent immediately keeps external code in sync.
  let intendedPaused = video.paused;
  Object.defineProperty(video, 'paused', {
    configurable: true,
    get: () => intendedPaused,
  });
  const onNativePause = () => {
    intendedPaused = true;
  };
  const onNativePlay = () => {
    intendedPaused = false;
  };
  video.addEventListener('pause', onNativePause);
  video.addEventListener('play', onNativePlay);

  // When an output device disappears (e.g. AirPods taken out), audio
  // briefly plays from whatever it falls back to (usually speakers)
  // before this app's own device-change handling pauses it. Fading that
  // pause would only stretch out the window of audio coming from the
  // wrong place, so skip the fade and cut instantly for a pause that
  // follows a device change.
  let recentDeviceChangeUntil = 0;
  const onDeviceChange = () => {
    recentDeviceChangeUntil = performance.now() + 1000;
  };
  navigator.mediaDevices.addEventListener('devicechange', onDeviceChange);

  video.pause = () => {
    const config = getConfig();
    const isDeviceChangePause = performance.now() < recentDeviceChangeUntil;
    if (!config?.fadeOnPause || intendedPaused || isDeviceChangePause) {
      intendedPaused = true;
      return originalVideoPause();
    }

    intendedPaused = true;
    const token = ++pauseFadeToken;
    debug.pauseFadeToken = pauseFadeToken;
    fader.rampTo(0, config.pauseFadeDuration, () => {
      if (token !== pauseFadeToken) return;
      originalVideoPause();
    });
    return undefined;
  };

  video.play = () => {
    intendedPaused = false;
    pauseFadeToken++; // invalidates any in-flight pause fade
    debug.pauseFadeToken = pauseFadeToken;
    // Resync to full whenever gain isn't already there: the pause fade
    // above may have been left running (invalidating it only skips the
    // final pause() call, not the gain animation), so gain could be
    // anywhere between 0 and 1 when play() is called for any reason -
    // but most play() calls (e.g. every normal song advance) don't need
    // this at all, so skip the no-op ramp when gain is already at rest.
    if (fader.get() < 1) {
      const config = getConfig();
      fader.rampTo(1, config?.pauseFadeDuration ?? 250);
    }
    return originalVideoPlay();
  };

  // Route the higher-level player API through the same patched methods,
  // in case something calls pauseVideo()/playVideo() without going
  // through video.pause()/play() directly.
  const originalApiPauseVideo = api.pauseVideo.bind(api);
  const originalApiPlayVideo = api.playVideo.bind(api);
  api.pauseVideo = () => video.pause();
  api.playVideo = () => video.play();

  // --- Manual song selection / skip (next / previous / playlist clicks) ---
  const skipTeardowns: Teardown[] = [];
  let skipFadeToken = 0;

  const onSongPlay = () => {
    intendedPaused = false;
    if (fader.get() < 1) {
      const config = getConfig();
      fader.rampTo(
        1,
        config?.skipFadeDuration ?? config?.pauseFadeDuration ?? 200,
      );
    }
  };
  video.addEventListener('play', onSongPlay);
  video.addEventListener('playing', onSongPlay);

  const onLoadStart = () => {
    const config = getConfig();
    if (config?.fadeOnSkip && fader.get() > 0 && !video.paused) {
      fader.rampTo(0, 100);
    }
  };
  video.addEventListener('loadstart', onLoadStart);

  const wrapTrackChange = <A extends unknown[], R>(
    fn?: (...args: A) => R,
  ): ((...args: A) => R | undefined) | undefined => {
    if (!fn) return undefined;
    return (...args: A) => {
      const config = getConfig();
      if (!config?.fadeOnSkip || video.paused || fader.get() <= 0) {
        return fn(...args);
      }

      const token = ++skipFadeToken;
      debug.skipFadeToken = skipFadeToken;
      fader.rampTo(0, config.skipFadeDuration, () => {
        if (token !== skipFadeToken) return;
        fn(...args);
      });
      return undefined;
    };
  };

  const originalNextVideo = api.nextVideo ? api.nextVideo.bind(api) : undefined;
  const originalPrevVideo = api.previousVideo
    ? api.previousVideo.bind(api)
    : undefined;
  const originalLoadByVars = api.loadVideoByPlayerVars
    ? api.loadVideoByPlayerVars.bind(api)
    : undefined;
  const originalLoadById = api.loadVideoById
    ? api.loadVideoById.bind(api)
    : undefined;
  const originalLoadByUrl = api.loadVideoByUrl
    ? api.loadVideoByUrl.bind(api)
    : undefined;
  const originalCueByVars = api.cueVideoByPlayerVars
    ? api.cueVideoByPlayerVars.bind(api)
    : undefined;
  const originalCueById = api.cueVideoById
    ? api.cueVideoById.bind(api)
    : undefined;
  const originalCueByUrl = api.cueVideoByUrl
    ? api.cueVideoByUrl.bind(api)
    : undefined;
  const originalLoadPlaylist = (
    api as unknown as { loadPlaylist?: (...args: unknown[]) => unknown }
  ).loadPlaylist
    ? (
        api as unknown as { loadPlaylist: (...args: unknown[]) => unknown }
      ).loadPlaylist.bind(api)
    : undefined;

  if (originalNextVideo) api.nextVideo = wrapTrackChange(originalNextVideo)!;
  if (originalPrevVideo)
    api.previousVideo = wrapTrackChange(originalPrevVideo)!;
  if (originalLoadByVars)
    api.loadVideoByPlayerVars = wrapTrackChange(originalLoadByVars)!;
  if (originalLoadById)
    api.loadVideoById = wrapTrackChange(originalLoadById)!;
  if (originalLoadByUrl)
    api.loadVideoByUrl = wrapTrackChange(originalLoadByUrl)!;
  if (originalCueByVars)
    api.cueVideoByPlayerVars = wrapTrackChange(originalCueByVars)!;
  if (originalCueById) api.cueVideoById = wrapTrackChange(originalCueById)!;
  if (originalCueByUrl) api.cueVideoByUrl = wrapTrackChange(originalCueByUrl)!;
  if (originalLoadPlaylist) {
    (api as unknown as { loadPlaylist: (...args: unknown[]) => unknown }).loadPlaylist =
      wrapTrackChange(originalLoadPlaylist)!;
  }

  let isBypassing = false;
  const onDocumentClick = (event: MouseEvent) => {
    if (isBypassing) return;

    const config = getConfig();
    if (!config?.fadeOnSkip || video.paused || fader.get() <= 0) return;

    const target = event.target as HTMLElement | null;
    if (!target) return;

    // Do not intercept if clicking on menus, like buttons, sliders, channels, browse links, or controls
    if (
      target.closest(
        'ytmusic-menu-renderer, ytmusic-like-button-renderer, tp-yt-paper-slider, #volume-slider, #progress-bar, ytmusic-toggle-menu-service-item-renderer, button[aria-label*="Menu"], button[aria-label*="More"], .dropdown-trigger, a[href*="/channel/"], a[href*="/browse/"]',
      )
    ) {
      return;
    }

    // Only intercept specific, verified play triggers (play buttons, thumbnails, song title links, queue items, skip buttons)
    const playTrigger = target.closest<HTMLElement>(
      'ytmusic-play-button-renderer, .next-button.ytmusic-player-bar, .previous-button.ytmusic-player-bar, ytmusic-player-queue-item .song-info, ytmusic-player-queue-item ytmusic-thumbnail-renderer, ytmusic-responsive-list-item-renderer .title a, ytmusic-responsive-list-item-renderer ytmusic-thumbnail-renderer, a[href*="watch?v="]',
    );

    if (!playTrigger) return;

    if (
      (playTrigger as HTMLButtonElement).disabled ||
      playTrigger.getAttribute('aria-disabled') === 'true'
    ) {
      return;
    }

    event.preventDefault();
    event.stopImmediatePropagation();

    const token = ++skipFadeToken;
    debug.skipFadeToken = skipFadeToken;

    fader.rampTo(0, config.skipFadeDuration, () => {
      if (token !== skipFadeToken) return;
      isBypassing = true;
      try {
        target.click();
      } finally {
        isBypassing = false;
      }

      // Safety net: If click didn't change tracks or start new playback within 300ms, restore volume
      setTimeout(() => {
        if (token === skipFadeToken && fader.get() < 1 && !video.paused) {
          fader.rampTo(1, config.skipFadeDuration);
        }
      }, 300);
    });
  };

  document.addEventListener('click', onDocumentClick, true);
  skipTeardowns.push(() =>
    document.removeEventListener('click', onDocumentClick, true),
  );

  return () => {
    video.removeEventListener('pause', onNativePause);
    video.removeEventListener('play', onNativePlay);
    video.removeEventListener('play', onSongPlay);
    video.removeEventListener('playing', onSongPlay);
    video.removeEventListener('loadstart', onLoadStart);
    navigator.mediaDevices.removeEventListener('devicechange', onDeviceChange);
    delete (video as { paused?: boolean }).paused;
    video.pause = originalVideoPause;
    video.play = originalVideoPlay;
    api.pauseVideo = originalApiPauseVideo;
    api.playVideo = originalApiPlayVideo;
    if (originalNextVideo) api.nextVideo = originalNextVideo;
    if (originalPrevVideo) api.previousVideo = originalPrevVideo;
    if (originalLoadByVars) api.loadVideoByPlayerVars = originalLoadByVars;
    if (originalLoadById) api.loadVideoById = originalLoadById;
    if (originalLoadByUrl) api.loadVideoByUrl = originalLoadByUrl;
    if (originalCueByVars) api.cueVideoByPlayerVars = originalCueByVars;
    if (originalCueById) api.cueVideoById = originalCueById;
    if (originalCueByUrl) api.cueVideoByUrl = originalCueByUrl;
    if (originalLoadPlaylist) {
      (api as unknown as { loadPlaylist: (...args: unknown[]) => unknown }).loadPlaylist =
        originalLoadPlaylist;
    }
    for (const teardown of skipTeardowns) teardown();
    debug.video = null;
  };
}

/**
 * Waits for the app's Web Audio graph (via peard:audio-can-play) and
 * inserts a GainNode into it, then attaches setupSmoothTransitions using
 * that gain node exclusively - no video.volume-based fallback. If the
 * video element is ever replaced (e.g. after the OS sleeps/wakes), the
 * gain node's binding to the old audio source goes stale, so fading is
 * disabled for the rest of that session rather than falling back to
 * touching video.volume directly, which would reintroduce the conflict
 * with plugins like Exponential Volume that this design avoids.
 *
 * Also exposes window.__smoothTransitionsDebug for inspection from
 * DevTools if something goes wrong.
 */
function superviseSmoothTransitions(
  api: MusicPlayer,
  getConfig: () => SmoothTransitionsPluginConfig | null,
): Teardown {
  let stopCurrent: Teardown | null = null;
  let fader: GainFader | null = null;
  let disabled = false;

  const debug: DebugState = {
    video: null,
    isFading: false,
    pauseFadeToken: 0,
    skipFadeToken: 0,
    gainReady: false,
    disabled: false,
  };
  (
    window as unknown as { __smoothTransitionsDebug: DebugState }
  ).__smoothTransitionsDebug = debug;

  const attachIfPossible = () => {
    if (disabled || !fader || stopCurrent) return;
    const video = document.querySelector<HTMLVideoElement>('video');
    if (!video) return;
    stopCurrent = setupSmoothTransitions(video, api, getConfig, debug, fader);
  };

  const onAudioCanPlay = (event: Event) => {
    if (fader || disabled) return;
    const { audioContext, audioSource } = (
      event as CustomEvent<AudioCanPlayDetail>
    ).detail;
    const video = document.querySelector<HTMLVideoElement>('video');
    try {
      const gainNode = audioContext.createGain();
      gainNode.gain.value = 0;
      audioSource.disconnect(audioContext.destination);
      audioSource.connect(gainNode);
      gainNode.connect(audioContext.destination);

      fader = createGainFader(gainNode, audioContext, debug);
      debug.gainReady = true;
    } catch (err) {
      console.error('[smooth-transitions] failed to insert gain node', err);
      disabled = true;
      debug.disabled = true;
      return;
    }

    attachIfPossible();
    // The instance's own native 'play'-driven resync only covers *future*
    // play() calls - if playback is already underway right now, that
    // event already fired before this fader existed, so nothing else
    // will trigger the fade-in unless done here.
    if (video && !video.paused) {
      fader.rampTo(1, 150);
    }
  };
  document.addEventListener('peard:audio-can-play', onAudioCanPlay);

  // Tracks the video element across calls independently of debug.video,
  // which only reflects whether setupSmoothTransitions is *currently*
  // attached (it's null both before the very first attach and whenever
  // fading is disabled) - comparing against that directly would treat the
  // first-ever sighting of the video as a "swap" before gain is even
  // ready, permanently disabling the plugin at startup.
  let lastSeenVideo: HTMLVideoElement | null = null;

  const onDomChange = () => {
    if (disabled) return;
    const video = document.querySelector<HTMLVideoElement>('video');
    if (!video) return;

    if (lastSeenVideo === null) {
      lastSeenVideo = video;
      attachIfPossible();
      return;
    }
    if (video === lastSeenVideo) {
      attachIfPossible();
      return;
    }

    // The video element was replaced (e.g. after sleep/wake, or a GPU
    // process restart). The gain node stays bound to the old, now-stale
    // audioSource - there's no safe way to reattach it to the new
    // element, and falling back to video.volume would reintroduce the
    // Exponential Volume conflict this design avoids. Disable fading for
    // the rest of this session instead of silently misbehaving.
    console.log(
      '[smooth-transitions] video element changed, disabling fades for this session',
    );
    lastSeenVideo = video;
    stopCurrent?.();
    stopCurrent = null;
    disabled = true;
    debug.disabled = true;
  };
  const observer = new MutationObserver(onDomChange);
  observer.observe(document.body, { childList: true, subtree: true });
  lastSeenVideo = document.querySelector<HTMLVideoElement>('video');
  attachIfPossible();

  return () => {
    observer.disconnect();
    document.removeEventListener('peard:audio-can-play', onAudioCanPlay);
    stopCurrent?.();
    fader?.dispose();
  };
}

export default createPlugin<
  unknown,
  unknown,
  {
    config: SmoothTransitionsPluginConfig | null;
    cleanup: Teardown | null;
  },
  SmoothTransitionsPluginConfig
>({
  name: () => t('plugins.smooth-transitions.name'),
  description: () => t('plugins.smooth-transitions.description'),
  restartNeeded: true,
  config: {
    enabled: false,
    fadeOnPause: true,
    pauseFadeDuration: 250,
    fadeOnSkip: true,
    skipFadeDuration: 200,
  },
  menu: async ({ getConfig, setConfig }) => {
    const config = await getConfig();

    return [
      {
        label: t('plugins.smooth-transitions.menu.fade-on-pause'),
        type: 'checkbox',
        checked: config.fadeOnPause,
        async click() {
          const now = await getConfig();
          setConfig({ fadeOnPause: !now.fadeOnPause });
        },
      },
      {
        label: t('plugins.smooth-transitions.menu.fade-on-skip'),
        type: 'checkbox',
        checked: config.fadeOnSkip,
        async click() {
          const now = await getConfig();
          setConfig({ fadeOnSkip: !now.fadeOnSkip });
        },
      },
    ];
  },
  renderer: {
    config: null,
    cleanup: null,
    async start({ getConfig }) {
      this.config = await getConfig();
    },
    onConfigChange(newConfig) {
      this.config = newConfig;
    },
    async onPlayerApiReady(api) {
      this.cleanup?.();
      // The crossfade plugin drives its own volume fades on the same
      // <video> element and auto-clicks the next button near the end of
      // a track. Fading here too would fight it for volume control and
      // can leave playback stuck silent, so step aside entirely.
      const crossfadeActive =
        await window.mainConfig.plugins.isEnabled('crossfade');
      if (crossfadeActive) return;
      // The audio-compressor plugin also reroutes the shared Web Audio
      // graph (source -> compressor -> destination). Inserting a gain
      // node into the same graph independently could race it and produce
      // duplicate/parallel audio paths, so step aside there too rather
      // than risk it - no fallback path exists to fall back to anymore.
      const audioCompressorActive =
        await window.mainConfig.plugins.isEnabled('audio-compressor');
      if (audioCompressorActive) return;
      this.cleanup = superviseSmoothTransitions(api, () => this.config);
    },
    stop() {
      this.cleanup?.();
      this.cleanup = null;
    },
  },
});
