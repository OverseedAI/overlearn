import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";

const STORAGE_KEY = "overlearn-ui-scale";
const DEFAULT_SCALE = 1;
const MIN_SCALE = 0.85;
const MAX_SCALE = 1.25;
const SCALE_STEP = 0.05;

type AppScaleContextValue = {
  scale: number;
  canZoomIn: boolean;
  canZoomOut: boolean;
  zoomIn: () => void;
  zoomOut: () => void;
  resetScale: () => void;
};

const AppScaleContext = createContext<AppScaleContextValue | undefined>(
  undefined,
);

function roundScale(value: number): number {
  return Math.round(value * 100) / 100;
}

function clampScale(value: number): number {
  return Math.min(MAX_SCALE, Math.max(MIN_SCALE, roundScale(value)));
}

function readStoredScale(): number {
  const stored = localStorage.getItem(STORAGE_KEY);
  if (stored === null) {
    return DEFAULT_SCALE;
  }

  const value = Number(stored);
  return Number.isFinite(value) ? clampScale(value) : DEFAULT_SCALE;
}

function isZoomInShortcut(event: KeyboardEvent): boolean {
  return event.key === "+" || event.key === "=" || event.code === "NumpadAdd";
}

function isZoomOutShortcut(event: KeyboardEvent): boolean {
  return event.key === "-" || event.code === "NumpadSubtract";
}

function isZoomResetShortcut(event: KeyboardEvent): boolean {
  return event.key === "0" || event.code === "Numpad0";
}

export function AppScaleProvider({ children }: { children: ReactNode }) {
  const [scale, setScaleState] = useState(readStoredScale);

  useEffect(() => {
    document.documentElement.style.fontSize =
      scale === DEFAULT_SCALE ? "" : `${Math.round(scale * 100)}%`;
  }, [scale]);

  const setScale = useCallback((next: number | ((current: number) => number)) => {
    setScaleState((current) => {
      const value = clampScale(
        typeof next === "function" ? next(current) : next,
      );

      if (value === DEFAULT_SCALE) {
        localStorage.removeItem(STORAGE_KEY);
      } else {
        localStorage.setItem(STORAGE_KEY, String(value));
      }

      return value;
    });
  }, []);

  const zoomIn = useCallback(() => {
    setScale((current) => current + SCALE_STEP);
  }, [setScale]);

  const zoomOut = useCallback(() => {
    setScale((current) => current - SCALE_STEP);
  }, [setScale]);

  const resetScale = useCallback(() => {
    setScale(DEFAULT_SCALE);
  }, [setScale]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if ((!event.metaKey && !event.ctrlKey) || event.altKey) {
        return;
      }

      if (isZoomInShortcut(event)) {
        event.preventDefault();
        zoomIn();
        return;
      }

      if (isZoomOutShortcut(event)) {
        event.preventDefault();
        zoomOut();
        return;
      }

      if (isZoomResetShortcut(event)) {
        event.preventDefault();
        resetScale();
      }
    };

    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [resetScale, zoomIn, zoomOut]);

  const value = useMemo(
    () => ({
      scale,
      canZoomIn: scale < MAX_SCALE,
      canZoomOut: scale > MIN_SCALE,
      zoomIn,
      zoomOut,
      resetScale,
    }),
    [resetScale, scale, zoomIn, zoomOut],
  );

  return (
    <AppScaleContext.Provider value={value}>
      {children}
    </AppScaleContext.Provider>
  );
}

export function useAppScale(): AppScaleContextValue {
  const context = useContext(AppScaleContext);
  if (!context) {
    throw new Error("useAppScale must be used within AppScaleProvider");
  }
  return context;
}
