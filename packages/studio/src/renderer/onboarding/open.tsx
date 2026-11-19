// How the rest of the app opens the tour: wrap the app in <OnboardingHost>, then call useOnboarding().open() anywhere inside it.
// The host also opens the tour by itself on the first launch, and records that it was seen when it closes.

import { createContext, useCallback, useContext, useMemo, useState, type JSX, type ReactNode } from 'react';
import { Onboarding } from './Onboarding.tsx';
import { CHAPTERS as LESSONS } from './story.ts';
import { markOnboardingSeen, onboardingSeen } from './seen.ts';

export { markOnboardingSeen, onboardingSeen };

export interface OnboardingApi {
  /** Opens the tour at a chapter (0 to 3; the first by default). */
  open(lesson?: number): void;
}

const OnboardingContext = createContext<OnboardingApi>({ open: () => {} });

export function useOnboarding(): OnboardingApi {
  return useContext(OnboardingContext);
}

export function OnboardingHost({ children }: { children: ReactNode }): JSX.Element {
  // n changes on every open, so asking again while it is showing starts the chosen lesson fresh.
  const [shown, setShown] = useState<{ lesson: number; n: number } | null>(() => (onboardingSeen() ? null : { lesson: 0, n: 0 }));
  const open = useCallback((lesson = 0): void => {
    const l = Number.isInteger(lesson) ? Math.min(Math.max(lesson, 0), LESSONS.length - 1) : 0;
    setShown((cur) => ({ lesson: l, n: (cur?.n ?? 0) + 1 }));
  }, []);
  const close = useCallback((): void => { markOnboardingSeen(); setShown(null); }, []);
  const api = useMemo<OnboardingApi>(() => ({ open }), [open]);
  return (
    <OnboardingContext.Provider value={api}>
      {children}
      {shown && <Onboarding key={shown.n} initialLesson={shown.lesson} onClose={close} />}
    </OnboardingContext.Provider>
  );
}
