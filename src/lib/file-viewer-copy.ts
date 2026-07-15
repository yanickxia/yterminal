/** Minimal keyboard fields needed by the file viewer's standard copy chord. */
export interface ViewerCopyKeyLike {
  key: string;
  ctrlKey: boolean;
  metaKey: boolean;
  shiftKey: boolean;
  altKey: boolean;
}

/** Standard copy shortcut for a non-terminal surface. */
export function isViewerCopyShortcut(
  event: ViewerCopyKeyLike,
  isMac: boolean
): boolean {
  if (event.key.toLowerCase() !== "c" || event.shiftKey || event.altKey) {
    return false;
  }
  return isMac
    ? event.metaKey && !event.ctrlKey
    : event.ctrlKey && !event.metaKey;
}

/** Selection fields needed to verify that a copy belongs to the viewer body. */
export interface ViewerSelectionLike {
  isCollapsed: boolean;
  anchorNode: Node | null;
  focusNode: Node | null;
  toString(): string;
}

export function selectionTextWithin(
  selection: ViewerSelectionLike | null,
  contains: (node: Node) => boolean
): string {
  if (
    !selection ||
    selection.isCollapsed ||
    !selection.anchorNode ||
    !selection.focusNode ||
    !contains(selection.anchorNode) ||
    !contains(selection.focusNode)
  ) {
    return "";
  }
  return selection.toString();
}
