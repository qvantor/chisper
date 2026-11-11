import React from 'react';
import { BehaviorSubject, distinctUntilChanged, map } from 'rxjs';
import { useObservable } from './use-observable';

// one field of the object of a BehaviorSubject: a component renders on a change of that field only, not on every
// new object (every step of a knob)
export const useBehaviorSubjectField = <T extends object, K extends keyof T>(
  subject: BehaviorSubject<T>,
  field: K
): T[K] => {
  const $value = React.useMemo(
    () =>
      subject.pipe(
        map((value) => value[field]),
        distinctUntilChanged()
      ),
    [subject, field]
  );
  return useObservable($value, subject.value[field]);
};
