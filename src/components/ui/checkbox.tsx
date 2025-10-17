import * as React from "react";

import { cn } from "../../lib/utils";

export interface CheckboxProps extends React.InputHTMLAttributes<HTMLInputElement> {
  label?: React.ReactNode;
}

export const Checkbox = React.forwardRef<HTMLInputElement, CheckboxProps>(({ className, label, ...props }, ref) => {
  return (
    <label className="inline-flex cursor-pointer items-center gap-2 text-sm text-slate-200">
      <span
        className={cn(
          "relative inline-flex h-5 w-5 items-center justify-center rounded-md border border-slate-600/60 bg-slate-900/60 transition focus-within:ring-2 focus-within:ring-mystic-300",
          className,
        )}
      >
        <input
          ref={ref}
          type="checkbox"
          className="peer absolute inset-0 h-full w-full cursor-pointer appearance-none rounded-md"
          {...props}
        />
        <span className="pointer-events-none inline-flex h-3 w-3 scale-0 rounded-sm bg-mystic-400 transition-transform duration-150 peer-checked:scale-100" />
      </span>
      {label && <span>{label}</span>}
    </label>
  );
});
Checkbox.displayName = "Checkbox";
