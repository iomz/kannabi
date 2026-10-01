"use client"

import { Popover as PopoverPrimitive } from "@base-ui/react/popover"
import { cn } from "cn"

/* Added for contextual help on the Asset page.
 *
 * Kannabi already had a Tooltip, and it is the wrong primitive for this: a
 * tooltip opens on hover and focus and closes again on click, so somebody who
 * taps or clicks the affordance — which is what people do — sees the help
 * disappear. A popover is the click-and-stay surface, dismissed by Escape, by
 * clicking away, or by activating the trigger again, and it takes focus with
 * it so a keyboard reader lands inside the text rather than past it.
 *
 * The Tooltip stays for what it is good at: naming a control on hover. */

function Popover({ ...props }: PopoverPrimitive.Root.Props) {
  return <PopoverPrimitive.Root data-slot="popover" {...props} />
}

function PopoverTrigger({ ...props }: PopoverPrimitive.Trigger.Props) {
  return <PopoverPrimitive.Trigger data-slot="popover-trigger" {...props} />
}

function PopoverContent({
  className,
  side = "top",
  sideOffset = 6,
  align = "center",
  alignOffset = 0,
  children,
  ...props
}: PopoverPrimitive.Popup.Props &
  Pick<
    PopoverPrimitive.Positioner.Props,
    "align" | "alignOffset" | "side" | "sideOffset"
  >) {
  return (
    <PopoverPrimitive.Portal>
      <PopoverPrimitive.Positioner
        align={align}
        alignOffset={alignOffset}
        side={side}
        sideOffset={sideOffset}
        className="isolate z-50"
      >
        <PopoverPrimitive.Popup
          data-slot="popover-content"
          className={cn(
            "z-50 w-72 max-w-[calc(100vw-2rem)] origin-(--transform-origin) rounded-lg bg-popover p-3 text-sm text-popover-foreground ring-1 ring-foreground/10 outline-none data-open:animate-in data-open:fade-in-0 data-open:zoom-in-95 data-closed:animate-out data-closed:fade-out-0 data-closed:zoom-out-95",
            className
          )}
          {...props}
        >
          {children}
        </PopoverPrimitive.Popup>
      </PopoverPrimitive.Positioner>
    </PopoverPrimitive.Portal>
  )
}

export { Popover, PopoverTrigger, PopoverContent }
