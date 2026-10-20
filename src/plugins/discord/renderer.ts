import { t } from '@/i18n';

import type { DiscordPluginConfig } from './index';
import type { RendererContext } from '@/types/contexts';

const BUTTON_ID = 'discord-presence-toggle';

const ICON =
  '<svg viewBox="0 0 24 24" width="24" height="24" fill="currentColor" aria-hidden="true"><path d="M19.27 5.33A17.5 17.5 0 0 0 14.97 4l-.2.4a16 16 0 0 1 3.9 1.3 13 13 0 0 0-5.1-1.5 14 14 0 0 0-3.1 0 13 13 0 0 0-5.1 1.5 16 16 0 0 1 3.9-1.3L9.1 4a17.5 17.5 0 0 0-4.3 1.33C2.1 9.3 1.4 13.2 1.7 17.1a17.6 17.6 0 0 0 5.3 2.7l1.1-1.8c-.6-.2-1.2-.5-1.8-.9l.4-.3a12.6 12.6 0 0 0 10.6 0l.4.3c-.6.4-1.2.7-1.8.9l1.1 1.8a17.6 17.6 0 0 0 5.3-2.7c.4-4.5-.7-8.4-3-11.8ZM8.7 14.8c-1 0-1.8-.9-1.8-2s.8-2 1.8-2 1.8.9 1.8 2-.8 2-1.8 2Zm6.6 0c-1 0-1.8-.9-1.8-2s.8-2 1.8-2 1.8.9 1.8 2-.8 2-1.8 2Z"/></svg>';

let button: HTMLButtonElement | undefined;

export const onRendererStart = async ({
  getConfig,
  setConfig,
}: RendererContext<DiscordPluginConfig>) => {
  let active = (await getConfig()).presenceActive;

  const render = () => {
    if (!button) return;
    button.style.opacity = active ? '1' : '0.4';
    button.setAttribute('aria-pressed', String(active));
  };

  button = document.createElement('button');
  button.id = BUTTON_ID;
  button.title = t('plugins.discord.button.tooltip');
  button.innerHTML = ICON;
  Object.assign(button.style, {
    width: '40px',
    height: '40px',
    border: 'none',
    background: 'transparent',
    color: 'var(--ytmusic-text-primary, currentColor)',
    cursor: 'pointer',
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
  });
  button.addEventListener('click', () => {
    active = !active;
    render();
    setConfig({ presenceActive: active });
  });

  render();
  document.querySelector('#right-content')?.prepend(button);
};

export const onRendererStop = () => {
  button?.remove();
  button = undefined;
};
