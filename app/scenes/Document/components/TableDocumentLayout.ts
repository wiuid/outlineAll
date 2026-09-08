const RIBBON_TABLIST_SELECTOR =
  '[data-u-comp="ribbon-header-menu"] > [role="tablist"]';

export const TABLE_DOCUMENT_MOBILE_MEDIA_QUERY = "(max-width: 768px)";

export function findRibbonHeaderMenu(
  container: HTMLElement
): HTMLElement | null {
  return (
    container.querySelector<HTMLElement>(RIBBON_TABLIST_SELECTOR)
      ?.parentElement ?? null
  );
}
