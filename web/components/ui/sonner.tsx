import { Toaster as Sonner, type ToasterProps } from "sonner"
import { CircleCheckIcon, OctagonXIcon } from "lucide-react"

import { useThemeRuntime } from "@/theme-runtime"

/** Sonner, wearing Kannabi's theme and carrying a remaining-time bar.
 *
 * Two departures from the file shadcn ships, both forced:
 *
 * Upstream reads the colour scheme from `next-themes`. Kannabi has no such
 * provider and resolves the scheme from an account preference before the first
 * paint, so `useTheme()` would fall back to "system" and a User set to Always
 * light on a dark machine would get dark toasts.
 *
 * Upstream styles Sonner with `var(--popover)` and friends. Kannabi maps those
 * names into Tailwind's namespace with `@theme inline`, which substitutes into
 * utilities and never emits them as variables, so each would resolve to
 * nothing and Sonner would fall back to its own palette. They point at
 * `--kannabi-*` instead.
 *
 * The icon is the only thing that carries the kind. The message and the
 * surface stay in the theme's ordinary colours — a whole toast in danger
 * colours is louder than the news usually is — so the mark beside it is where
 * success and failure are told apart, in the same tokens the rest of Kannabi
 * uses for those states.
 */
function Toaster({ seconds, ...props }: ToasterProps & { seconds: number }) {
  const { colorScheme } = useThemeRuntime()
  return (
    <Sonner
      theme={colorScheme}
      position="top-right"
      duration={seconds * 1000}
      closeButton
      icons={{
        success: <CircleCheckIcon className="size-4 text-success-text" />,
        error: <OctagonXIcon className="size-4 text-danger-text" />,
      }}
      style={
        {
          "--normal-bg": "var(--kannabi-surface)",
          "--normal-text": "var(--kannabi-text)",
          "--normal-border": "var(--kannabi-border)",
          "--success-bg": "var(--kannabi-surface)",
          "--success-text": "var(--kannabi-text)",
          "--success-border": "var(--kannabi-border)",
          "--error-bg": "var(--kannabi-surface)",
          "--error-text": "var(--kannabi-text)",
          "--error-border": "var(--kannabi-border)",
          "--border-radius": "var(--radius)",
          // Inherited by every toast, so the bar and the timer are given the
          // same number. A caller asking for its own duration overrides both.
          "--kannabi-toast-duration": `${seconds}s`,
        } as React.CSSProperties
      }
      {...props}
    />
  )
}

export { Toaster }
