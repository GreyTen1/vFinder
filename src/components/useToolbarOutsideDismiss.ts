import { RefObject, useEffect } from "react";

export function useToolbarOutsideDismiss(
  dialogRef: RefObject<HTMLElement | null>,
  active: boolean,
  onClose: () => void,
  blocked = false
) {
  useEffect(() => {
    if (!active || blocked) return;

    const handleMouseDown = (event: MouseEvent) => {
      const target = event.target instanceof Element ? event.target : null;
      if (
        target?.closest("[data-app-toolbar]") &&
        dialogRef.current &&
        !dialogRef.current.contains(target)
      ) {
        onClose();
      }
    };

    document.addEventListener("mousedown", handleMouseDown, true);
    return () => document.removeEventListener("mousedown", handleMouseDown, true);
  }, [active, blocked, dialogRef, onClose]);
}
