interface FocusTarget {
  focus(): void;
}

interface FocusRoot {
  querySelector(selector: string): FocusTarget | null;
}

export function focusAppDestination(root: FocusRoot): boolean {
  const target = root.querySelector(".desktop-nav [aria-current='page']");
  if (!target) return false;
  target.focus();
  return true;
}
