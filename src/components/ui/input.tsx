import * as React from "react";

import { cn } from "../../lib/utils";

export interface InputProps extends React.InputHTMLAttributes<HTMLInputElement> {}

const Input = React.forwardRef<HTMLInputElement, InputProps>(({ className, type, ...props }, ref) => {
  return (
    <input
      type={type}
      className={cn(
        "flex h-11 w-full rounded-full border border-slate-700/60 bg-slate-900/60 px-5 text-sm text-slate-100 shadow-inner shadow-mystic/10 transition placeholder:text-slate-400 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-mystic-300",
        className,
      )}
      ref={ref}
      {...props}
    />
  );
});
Input.displayName = "Input";

export { Input };
