import * as React from "react"
import { cva, type VariantProps } from "class-variance-authority"
import { Slot } from "radix-ui"

import { cn } from "@/lib/utils"
import type { PluginButtonColors as ButtonColors } from "@/src/core"

const buttonVariants = cva(
  "inline-flex shrink-0 items-center justify-center gap-2 rounded-md text-sm font-medium whitespace-nowrap transition-all outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50 disabled:pointer-events-none disabled:opacity-50 aria-invalid:border-destructive aria-invalid:ring-destructive/20 dark:aria-invalid:ring-destructive/40 [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4",
  {
    variants: {
      variant: {
        default: "bg-primary text-primary-foreground hover:bg-primary/90",
        destructive:
          "bg-destructive text-white hover:bg-destructive/90 focus-visible:ring-destructive/20 dark:bg-destructive/60 dark:focus-visible:ring-destructive/40",
        outline:
          "border bg-background shadow-xs hover:bg-accent hover:text-accent-foreground dark:border-input dark:bg-input/30 dark:hover:bg-input/50",
        secondary:
          "bg-secondary text-secondary-foreground hover:bg-secondary/80",
        ghost:
          "hover:bg-accent hover:text-accent-foreground dark:hover:bg-accent/50",
        link: "text-primary underline-offset-4 hover:underline",
        custom: "border border-transparent bg-primary text-primary-foreground",
      },
      size: {
        default: "h-9 px-4 py-2 has-[>svg]:px-3 has-[>[data-slot=button-icon]]:px-3",
        xs: "h-6 gap-1 rounded-md px-2 text-xs has-[>svg]:px-1.5 has-[>[data-slot=button-icon]]:px-1.5 [&_svg:not([class*='size-'])]:size-3",
        sm: "h-8 gap-1.5 rounded-md px-3 has-[>svg]:px-2.5 has-[>[data-slot=button-icon]]:px-2.5",
        lg: "h-10 rounded-md px-6 has-[>svg]:px-4 has-[>[data-slot=button-icon]]:px-4",
        icon: "size-9",
        "icon-xs": "size-6 rounded-md [&_svg:not([class*='size-'])]:size-3",
        "icon-sm": "size-8",
        "icon-lg": "size-10",
      },
    },
    defaultVariants: {
      variant: "default",
      size: "default",
    },
  }
)

function customButtonColors(colors?: ButtonColors) {
  const style: React.CSSProperties & Record<`--button-custom-${string}`, string> = {}
  const classes: string[] = []
  const add = (value: string | undefined, variable: `--button-custom-${string}`, className: string) => {
    if (value === undefined) return
    style[variable] = value
    classes.push(className)
  }
  // Keep complete utility names static for Tailwind discovery. Missing slots
  // add no state utility, so each property retains its applicable lower color.
  add(colors?.background, "--button-custom-background", "bg-[color:var(--button-custom-background)]")
  add(colors?.text, "--button-custom-text", "text-[color:var(--button-custom-text)]")
  add(colors?.border, "--button-custom-border", "border-[color:var(--button-custom-border)]")
  add(colors?.hover?.background, "--button-custom-hover-background", "hover:bg-[color:var(--button-custom-hover-background)]")
  add(colors?.hover?.text, "--button-custom-hover-text", "hover:text-[color:var(--button-custom-hover-text)]")
  add(colors?.hover?.border, "--button-custom-hover-border", "hover:border-[color:var(--button-custom-hover-border)]")
  add(colors?.active?.background, "--button-custom-active-background", "active:bg-[color:var(--button-custom-active-background)]")
  add(colors?.active?.text, "--button-custom-active-text", "active:text-[color:var(--button-custom-active-text)]")
  add(colors?.active?.border, "--button-custom-active-border", "active:border-[color:var(--button-custom-active-border)]")
  add(colors?.focusVisible?.background, "--button-custom-focus-visible-background", "focus-visible:bg-[color:var(--button-custom-focus-visible-background)]")
  add(colors?.focusVisible?.text, "--button-custom-focus-visible-text", "focus-visible:text-[color:var(--button-custom-focus-visible-text)]")
  add(colors?.focusVisible?.border, "--button-custom-focus-visible-border", "focus-visible:border-[color:var(--button-custom-focus-visible-border)]")
  add(colors?.focusVisible?.ring, "--button-custom-focus-visible-ring", "focus-visible:ring-[color:var(--button-custom-focus-visible-ring)]")
  add(colors?.disabled?.background, "--button-custom-disabled-background", "disabled:bg-[color:var(--button-custom-disabled-background)]")
  add(colors?.disabled?.text, "--button-custom-disabled-text", "disabled:text-[color:var(--button-custom-disabled-text)]")
  add(colors?.disabled?.border, "--button-custom-disabled-border", "disabled:border-[color:var(--button-custom-disabled-border)]")
  return { style, classes }
}

function Button({
  className,
  colors,
  style,
  variant = "default",
  size = "default",
  asChild = false,
  ...props
}: React.ComponentProps<"button"> &
  VariantProps<typeof buttonVariants> & {
    asChild?: boolean
    colors?: ButtonColors
  }) {
  const Comp = asChild ? Slot.Root : "button"
  const customColors = variant === "custom" ? customButtonColors(colors) : undefined

  return (
    <Comp
      data-slot="button"
      data-variant={variant}
      data-size={size}
      className={cn(buttonVariants({ variant, size }), customColors?.classes, className)}
      style={customColors ? { ...customColors.style, ...style } : style}
      {...props}
    />
  )
}

export { Button, buttonVariants }
