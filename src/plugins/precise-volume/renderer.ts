import { debounce } from '@/providers/decorators';

import { type PreciseVolumePluginConfig } from './index';

import type { RendererContext } from '@/types/contexts';
import type { MusicPlayer } from '@/types/music-player';

function $<E extends Element = Element>(selector: string) {
  return document.querySelector<E>(selector);
}

let api: MusicPlayer;

export const moveVolumeHud = debounce((showVideo: boolean) => {
  const volumeHud = $<HTMLElement>('#volumeHud');
  if (!volumeHud) {
    return;
  }

  volumeHud.style.top = showVideo
    ? `${($('ytmusic-player')!.clientHeight - $('video')!.clientHeight) / 2}px`
    : '0';
}, 250);

let options: PreciseVolumePluginConfig;

export const onPlayerApiReady = async (
  playerApi: MusicPlayer,
  context: RendererContext<PreciseVolumePluginConfig>,
) => {
  api = playerApi;
  options =
    (window.mainConfig.get(
      'plugins.precise-volume',
    ) as PreciseVolumePluginConfig) ?? (await context.getConfig());

  // updateVolumeSlider() clamps any 1-4 value to "5" for display (the
  // slider can't render below 5 meaningfully) - the observer below must
  // not mistake that self-inflicted mutation for a manual drag, or every
  // volume saved as 1-4 gets immediately overwritten to 5.
  let suppressNextSliderChange = false;

  // Without this it would rewrite config 20 times when volume changes by 20.
  // Debounced, and flush on unload/pagehide so Cmd+Q never drops the saved volume.
  let pendingSave: ReturnType<typeof setTimeout> | null = null;
  const flushSave = () => {
    if (pendingSave !== null) {
      clearTimeout(pendingSave);
      pendingSave = null;
    }
    if (options && typeof options.savedVolume === 'number') {
      context.setConfig(options);
    }
  };

  const writeOptions = () => {
    if (pendingSave !== null) clearTimeout(pendingSave);
    pendingSave = setTimeout(() => {
      pendingSave = null;
      context.setConfig(options);
    }, 200);
  };

  window.addEventListener('beforeunload', flushSave);
  window.addEventListener('pagehide', flushSave);

  const hideVolumeHud = debounce((volumeHud: HTMLElement) => {
    volumeHud.style.opacity = '0';
  }, 2000);

  const hideVolumeSlider = debounce((slider: HTMLElement) => {
    slider.classList.remove('on-hover');
  }, 2500);

  /** Restore saved volume and setup tooltip */
  async function firstRun() {
    if (typeof options.savedVolume === 'number') {
      // Set saved volume as tooltip
      setTooltip(options.savedVolume);
      api.setVolume(options.savedVolume);
      updateVolumeSlider();
    }

    setupPlaybar();

    setupLocalArrowShortcuts();

    // Workaround: computedStyleMap().get(string) returns CSSKeywordValue instead of CSSStyleValue
    const noVid =
      ($('#main-panel')?.computedStyleMap().get('display') as CSSKeywordValue)
        ?.value === 'none';
    injectVolumeHud(noVid);
    if (!noVid) {
      setupVideoPlayerOnwheel();
      if (!(await window.mainConfig.plugins.isEnabled('video-toggle'))) {
        // Video-toggle handles hud positioning on its own
        const videoMode = () =>
          api.getPlayerResponse().videoDetails?.musicVideoType !==
          'MUSIC_VIDEO_TYPE_ATV';
        $('video')?.addEventListener('peard:src-changed', () =>
          moveVolumeHud(videoMode()),
        );
      }
    }
  }

  function injectVolumeHud(noVid: boolean) {
    if (noVid) {
      const position = 'top: 18px; right: 60px;';
      const mainStyle = 'font-size: xx-large;';

      $('.center-content.ytmusic-nav-bar')?.insertAdjacentHTML(
        'beforeend',
        `<span id="volumeHud" style="${position + mainStyle}"></span>`,
      );
    } else {
      const position = 'top: 10px; left: 10px;';
      const mainStyle =
        'font-size: xxx-large; webkit-text-stroke: 1px black; font-weight: 600;';

      $('#song-video')?.insertAdjacentHTML(
        'afterend',
        `<span id="volumeHud" style="${position + mainStyle}"></span>`,
      );
    }
  }

  function showVolumeHud(volume: number) {
    const volumeHud = $<HTMLElement>('#volumeHud');
    if (!volumeHud) {
      return;
    }

    volumeHud.textContent = `${volume}%`;
    volumeHud.style.opacity = '1';

    hideVolumeHud(volumeHud);
  }

  let accumulatedWheelDelta = 0;
  let lastWheelTime = 0;
  const MIN_DELTA = 3;
  const PIXELS_PER_STEP = 60;
  const MAX_DELTA_PER_EVENT = 22;

  function onWheel(event: WheelEvent) {
    event.preventDefault();
    if (event.ctrlKey) return;

    const absDelta = Math.abs(event.deltaY);
    if (absDelta < MIN_DELTA) {
      return;
    }

    const now = performance.now();
    if (now - lastWheelTime > 60) {
      accumulatedWheelDelta = 0;
    }
    lastWheelTime = now;

    let delta = event.deltaY;
    if (event.deltaMode === 1) {
      // DOM_DELTA_LINE (mouse wheel)
      delta *= 20;
    } else if (event.deltaMode === 2) {
      // DOM_DELTA_PAGE
      delta *= 40;
    }

    // Clamp fast fling bursts to prevent runaway acceleration
    if (Math.abs(delta) > MAX_DELTA_PER_EVENT) {
      delta = MAX_DELTA_PER_EVENT * Math.sign(delta);
    }

    accumulatedWheelDelta += delta;

    let stepsApplied = 0;
    while (
      Math.abs(accumulatedWheelDelta) >= PIXELS_PER_STEP &&
      stepsApplied < 1
    ) {
      const toIncrease = accumulatedWheelDelta < 0;
      changeVolume(toIncrease);
      stepsApplied++;
      if (accumulatedWheelDelta > 0) {
        accumulatedWheelDelta -= PIXELS_PER_STEP;
      } else {
        accumulatedWheelDelta += PIXELS_PER_STEP;
      }
    }

    // Bleed off excess momentum so it doesn't queue up or coast
    if (Math.abs(accumulatedWheelDelta) > PIXELS_PER_STEP) {
      accumulatedWheelDelta =
        Math.sign(accumulatedWheelDelta) * (PIXELS_PER_STEP - 1);
    }
  }

  /** Add onwheel event to video player */
  function setupVideoPlayerOnwheel() {
    const panel = $<HTMLElement>('#main-panel');
    if (!panel) return;

    panel.addEventListener('wheel', onWheel);
  }

  function saveVolume(volume: number) {
    options.savedVolume = volume;
    writeOptions();
  }

  /** Add onwheel event to play bar and also track if play bar is hovered */
  function setupPlaybar() {
    const playerbar = $<HTMLElement>('ytmusic-player-bar');
    if (!playerbar) return;

    playerbar.addEventListener('wheel', onWheel);

    // Keep track of mouse position for showVolumeSlider()
    playerbar.addEventListener('mouseenter', () => {
      playerbar.classList.add('on-hover');
    });

    playerbar.addEventListener('mouseleave', () => {
      playerbar.classList.remove('on-hover');
    });

    const onVolumeChange = () => {
      const currentVolume = api ? api.getVolume() : undefined;
      if (
        typeof currentVolume === 'number' &&
        !isNaN(currentVolume) &&
        currentVolume >= 0 &&
        options.savedVolume !== currentVolume
      ) {
        options.savedVolume = currentVolume;
        setTooltip(currentVolume);
        writeOptions();
      }
    };

    document
      .querySelector('video')
      ?.addEventListener('volumechange', onVolumeChange);

    setupSliderObserver();
  }

  /** Save volume + Update the volume tooltip when volume-slider is manually changed */
  function setupSliderObserver() {
    const sliderObserver = new MutationObserver((mutations) => {
      if (suppressNextSliderChange) {
        suppressNextSliderChange = false;
        return;
      }
      for (const mutation of mutations) {
        if (mutation.target.nodeName === 'TP-YT-PAPER-SLIDER') {
          // This checks that volume-slider was manually set
          const target = mutation.target as HTMLInputElement;
          const targetValueNumeric = Number(target.value);
          if (
            mutation.oldValue !== target.value &&
            options.savedVolume !== targetValueNumeric
          ) {
            setTooltip(targetValueNumeric);
            saveVolume(targetValueNumeric);
          }
        }
      }
    });

    const slider = $('#volume-slider');
    if (!slider) return;

    // Observing only changes in 'value' of volume-slider
    sliderObserver.observe(slider, {
      attributeFilter: ['value'],
      attributeOldValue: true,
    });
    // updateVolumeSlider() may already have run once during the startup
    // restore, before this observer existed to consume the suppress flag
    // it set - clear any such leftover now so it doesn't wrongly swallow
    // the first real mutation this observer actually sees.
    suppressNextSliderChange = false;
  }

  function setVolume(value: number) {
    api.setVolume(value);
    // Save the new volume
    saveVolume(value);

    // Change slider position (important)
    updateVolumeSlider();

    // Change tooltips to new value
    setTooltip(value);
    // Show volume slider
    showVolumeSlider();
    // Show volume HUD
    showVolumeHud(value);
  }

  /** If (toIncrease = false) then volume decrease */
  function changeVolume(toIncrease: boolean) {
    // Apply volume change if valid
    const steps = Number(options.steps || 1);
    setVolume(
      toIncrease
        ? Math.min(api.getVolume() + steps, 100)
        : Math.max(api.getVolume() - steps, 0),
    );
  }

  function updateVolumeSlider() {
    const savedVolume = options.savedVolume ?? 0;
    suppressNextSliderChange = true;
    // Slider value automatically rounds to multiples of 5
    for (const slider of ['#volume-slider', '#expand-volume-slider']) {
      const silderElement = $<HTMLInputElement>(slider);
      if (silderElement) {
        silderElement.value = String(
          savedVolume > 0 && savedVolume < 5 ? 5 : savedVolume,
        );
      }
    }
  }

  function showVolumeSlider() {
    const slider = $<HTMLElement>('#volume-slider');
    if (!slider) return;

    // This class display the volume slider if not in minimized mode
    slider.classList.add('on-hover');

    hideVolumeSlider(slider);
  }

  // Set new volume as tooltip for volume slider and icon + expanding slider (appears when window size is small)
  const tooltipTargets = [
    '#volume-slider',
    'tp-yt-paper-icon-button.volume',
    '#expand-volume-slider',
    '#expand-volume',
  ];

  function setTooltip(volume: number) {
    for (const target of tooltipTargets) {
      const tooltipTargetElement = $<HTMLElement>(target);
      if (tooltipTargetElement) {
        tooltipTargetElement.title = `${volume}%`;
      }
    }
  }

  function setupLocalArrowShortcuts() {
    if (options.arrowsShortcut) {
      window.addEventListener('keydown', (event) => {
        if (
          $<HTMLElement & { opened: boolean }>('ytmusic-search-box')?.opened
        ) {
          return;
        }

        switch (event.code) {
          case 'ArrowUp': {
            event.preventDefault();
            changeVolume(true);
            break;
          }

          case 'ArrowDown': {
            event.preventDefault();
            changeVolume(false);
            break;
          }
        }
      });
    }
  }

  context.ipc.on('changeVolume', (toIncrease: boolean) =>
    changeVolume(toIncrease),
  );
  context.ipc.on('setVolume', (value: number) => setVolume(value));

  await firstRun();
};

export const onConfigChange = (config: PreciseVolumePluginConfig) => {
  options = config;
};
