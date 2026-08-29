import { t } from '@/i18n';
import { createPlugin } from '@/utils';

import type { MusicPlayer } from '@/types/music-player';

export default createPlugin({
  name: () => t('plugins.exponential-volume.name'),
  description: () => t('plugins.exponential-volume.description'),
  restartNeeded: true,
  config: {
    enabled: false,
  },
  renderer: {
    start() {
      // Manipulation exponent, higher value = lower volume
      // 3 is the value used by pulseaudio
      const EXPONENT = 3;

      const storedOriginalVolumes = new WeakMap<HTMLMediaElement, number>();
      const propertyDescriptor = Object.getOwnPropertyDescriptor(
        HTMLMediaElement.prototype,
        'volume',
      );
      Object.defineProperty(HTMLMediaElement.prototype, 'volume', {
        get(this: HTMLMediaElement) {
          const lowVolume =
            (propertyDescriptor?.get?.call(this) as number) ?? 0;
          const calculatedOriginalVolume = lowVolume ** (1 / EXPONENT);

          const storedOriginalVolume = storedOriginalVolumes.get(this) ?? 0;
          const storedDeviation = Math.abs(
            storedOriginalVolume - calculatedOriginalVolume,
          );

          return storedDeviation < 0.01
            ? storedOriginalVolume
            : calculatedOriginalVolume;
        },
        set(this: HTMLMediaElement, originalVolume: number) {
          const lowVolume = originalVolume ** EXPONENT;
          storedOriginalVolumes.set(this, originalVolume);
          propertyDescriptor?.set?.call(this, lowVolume);
        },
      });
    },
    onPlayerApiReady(playerApi) {
      const syncVolume = (playerApi: MusicPlayer) => {
        if (playerApi.getPlayerState() === 3) {
          setTimeout(() => syncVolume(playerApi), 0);
          return;
        }

        playerApi.setVolume(playerApi.getVolume());
      };

      syncVolume(playerApi);
    },
  },
});
