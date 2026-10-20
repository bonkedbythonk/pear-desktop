import { app } from 'electron';

import {
  registerCallback,
  SongInfoEvent,
  type SongInfo,
} from '@/providers/song-info';
import { createBackend } from '@/utils';

import { TIME_UPDATE_DEBOUNCE_MS } from './constants';
import { DiscordService } from './discord-service';

import type { DiscordPluginConfig } from './index';

export let discordService = null as DiscordService | null;

// Latest song seen, kept even while presence is off so toggling on can show it at once
let latestSongInfo: SongInfo | undefined;
let callbackRegistered = false;

export const backend = createBackend<
  {
    config?: DiscordPluginConfig;
    lastTimeUpdateSent: number;
  },
  DiscordPluginConfig
>({
  lastTimeUpdateSent: 0,

  async start(ctx) {
    // Get initial configuration from the context
    const config = await ctx.getConfig();
    discordService = new DiscordService(ctx.window, config);

    // The plugin can be enabled after the window is already shown, so don't wait for it
    discordService.connect(!config.autoReconnect);

    if (!callbackRegistered) {
      callbackRegistered = true;
      registerCallback((songInfo, event) => {
        latestSongInfo = songInfo;
        if (!discordService?.isConnected()) return;

        if (event !== SongInfoEvent.TimeChanged) {
          discordService.updateActivity(songInfo);
          this.lastTimeUpdateSent = Date.now();
        } else {
          const now = Date.now();
          if (now - this.lastTimeUpdateSent > TIME_UPDATE_DEBOUNCE_MS) {
            discordService.updateActivity(songInfo);
            this.lastTimeUpdateSent = now; // Record the time of this debounced update
          }
        }
      });
    }

    // Time events start the song info flowing; the player may already be loaded
    ctx.ipc.send('peard:setup-time-changed-listener');

    ctx.ipc.on('peard:player-api-loaded', () => {
      ctx.ipc.send('peard:setup-time-changed-listener');
    });

    app.on('before-quit', () => {
      discordService?.cleanup();
    });
  },

  stop() {
    discordService?.cleanup();
  },

  onConfigChange(newConfig) {
    discordService?.onConfigChange(newConfig);

    if (newConfig.enabled && discordService?.isConnected()) {
      if (!newConfig.presenceActive) {
        discordService.clearActivity();
        return;
      }
      if (latestSongInfo) discordService.updateActivity(latestSongInfo);
    }

    const currentlyConnected = discordService?.isConnected() ?? false;
    if (newConfig.enabled && !currentlyConnected) {
      discordService?.connect(!newConfig.autoReconnect);
    } else if (!newConfig.enabled && currentlyConnected) {
      discordService?.disconnect();
    }
  },
});
