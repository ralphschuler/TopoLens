import * as React from "react";
import { cva, type VariantProps } from "class-variance-authority";

import { cn } from "../../lib/utils";

const badgeVariants = cva(
  "inline-flex items-center rounded-full px-3 py-1 text-xs font-semibold uppercase tracking-wide",
  {
    variants: {
      variant: {
        default: "bg-mystic-500/20 text-mystic-100 ring-1 ring-inset ring-mystic-400/40",
        success: "bg-verdant/20 text-verdant ring-1 ring-inset ring-verdant/40",
        warning: "bg-amber-400/20 text-amber-200 ring-1 ring-inset ring-amber-400/40",
        destructive: "bg-rose-500/20 text-rose-200 ring-1 ring-inset ring-rose-400/40",
      },
    },
    defaultVariants: {
      variant: "default",
    },
  },
);

export interface BadgeProps
  extends React.HTMLAttributes<HTMLDivElement>,
    VariantProps<typeof badgeVariants> {}

export function Badge({ className, variant, ...props }: BadgeProps) {
  return <div className={cn(badgeVariants({ variant }), className)} {...props} />;
}
