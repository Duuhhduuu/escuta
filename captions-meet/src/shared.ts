/** Etiqueta das mensagens da página para o content script (para ignorar o resto do que passa por postMessage). */
export const SOURCE = "escuta-legendas";

/** Código da sala: `abc-defg-hij`, de `/abc-defg-hij` ou `/meet/abc-defg-hij`. */
export const roomFromPath = (pathname: string): string | null => /^\/(?:meet\/)?([a-z]{3}-[a-z]{4}-[a-z]{3})(?:\/|$)/.exec(pathname)?.[1] ?? null;
