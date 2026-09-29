"use client"

import { Tabs as TabsPrimitive } from "@base-ui/react/tabs"
import { cn } from "cn"

/* Added for switching between two operations inside one section.
 *
 * Kannabi's Inventory scope strip looks like tabs and is not: its scope lives
 * in the URL, so it is a nav of links carrying `aria-current`, and it cannot
 * be reused for a choice held in component state. This is that choice — one
 * panel at a time, no navigation — so it takes the tab roles, the arrow-key
 * movement between them and the panel association from the primitive rather
 * than from hand-written ARIA.
 *
 * The visual language deliberately matches the Inventory strip: an underline
 * on the active item, so two controls that look alike behave alike. */

function Tabs({ className, ...props }: TabsPrimitive.Root.Props) {
  return (
    <TabsPrimitive.Root
      data-slot="tabs"
      className={cn("flex flex-col gap-4", className)}
      {...props}
    />
  )
}

function TabsList({ className, ...props }: TabsPrimitive.List.Props) {
  return (
    <TabsPrimitive.List
      data-slot="tabs-list"
      className={cn("flex items-stretch gap-1 border-b", className)}
      {...props}
    />
  )
}

function TabsTab({ className, ...props }: TabsPrimitive.Tab.Props) {
  return (
    <TabsPrimitive.Tab
      data-slot="tabs-tab"
      className={cn(
        "-mb-px cursor-pointer border-b-2 border-transparent px-4 py-2 text-[.85rem] whitespace-nowrap text-foreground transition-colors outline-none hover:bg-accent focus-visible:ring-3 focus-visible:ring-ring/50 data-selected:border-selected-indicator data-selected:font-semibold data-selected:text-selected-text",
        className
      )}
      {...props}
    />
  )
}

function TabsPanel({ className, ...props }: TabsPrimitive.Panel.Props) {
  return (
    <TabsPrimitive.Panel
      data-slot="tabs-panel"
      className={cn("outline-none", className)}
      {...props}
    />
  )
}

export { Tabs, TabsList, TabsTab, TabsPanel }
