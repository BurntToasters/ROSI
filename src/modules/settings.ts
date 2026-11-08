export function bindExternalLink(
  element: HTMLElement | null,
  url: string,
  openExternal: (url: string) => unknown
) {
  if (!element || typeof openExternal !== 'function') return;
  element.addEventListener('click', (event) => {
    event.preventDefault();
    event.stopPropagation();
    openExternal(url);
  });
}
