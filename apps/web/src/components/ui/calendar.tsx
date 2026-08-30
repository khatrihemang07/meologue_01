/**
 * The shadcn `calendar` primitive (issue #146), hand-written rather than
 * pulled via `npx shadcn add calendar` — that command wanted to overwrite
 * this repo's `button.tsx` with its own registry copy (a different `cva`
 * shape than the one `button.tsx`'s own comment history has settled on),
 * and this file has exactly one caller so far (`date-picker-sheet.tsx`),
 * which makes hand-matching the house style cheaper than reconciling two
 * `button.tsx`s.
 *
 * This wraps `react-day-picker`'s `DayPicker`, whose v10 API keys
 * `classNames` by the `UI`/`DayFlag`/`SelectionState` enums re-exported from
 * `react-day-picker` (`root`, `day_button`, `selected`, `today`, ...) rather
 * than the ad-hoc class names older shadcn calendar snapshots use — so this
 * file does not read like the calendar.tsx a search engine turns up for an
 * older react-day-picker major, deliberately.
 *
 * Nothing here decides which dates are selectable or what a selection means
 * — `date-picker-sheet.tsx` owns that. This primitive only renders a month
 * grid and lets its caller feed it `classNames`/`components` overrides the
 * same way every other `ui/` primitive in this repo forwards props.
 */
import { ChevronLeftIcon, ChevronRightIcon } from "lucide-react";
import type * as React from "react";
import { DayPicker } from "react-day-picker";
import { buttonVariants } from "@/components/ui/button";
import { cn } from "@/lib/utils";

function Calendar({
  className,
  classNames,
  showOutsideDays = true,
  ...props
}: React.ComponentProps<typeof DayPicker>) {
  return (
    <DayPicker
      data-slot="calendar"
      showOutsideDays={showOutsideDays}
      className={cn("w-fit p-2", className)}
      classNames={{
        // `relative` is load-bearing, not decoration: `nav` below is
        // absolutely positioned, so without a positioned ancestor here it
        // anchors to whatever container the calendar happens to sit in — in
        // the date-picker Sheet that put the previous-month chevron on top of
        // the sheet's own heading and threw the next-month one into the
        // opposite corner. Caught on a device screenshot, not by a test.
        root: "relative w-fit",
        months: "flex flex-col gap-4",
        month: "flex w-full flex-col gap-3",
        nav: "absolute inset-x-0 top-0 flex items-center justify-between px-2",
        button_previous: cn(buttonVariants({ variant: "ghost", size: "icon-sm" })),
        button_next: cn(buttonVariants({ variant: "ghost", size: "icon-sm" })),
        month_caption: "flex h-8 w-full items-center justify-center",
        caption_label: "text-sm font-medium",
        month_grid: "w-full border-collapse",
        weekdays: "flex",
        weekday: "flex-1 select-none text-center text-xs font-normal text-muted-foreground",
        week: "mt-1 flex w-full",
        day: "relative flex-1 p-0 text-center text-sm focus-within:relative focus-within:z-20",
        day_button: cn(
          buttonVariants({ variant: "ghost" }),
          "size-8 w-full rounded-lg p-0 font-normal aria-selected:opacity-100",
        ),
        range_start: "rounded-l-lg",
        range_end: "rounded-r-lg",
        range_middle: "rounded-none",
        // The two states a reader actually needs to tell apart at a glance:
        // "today" (a neutral outline via the accent tokens) and "selected"
        // (the primary fill) — `entry-actions.tsx`'s house tokens, applied
        // to the `<button>` this classname's `<td>` wraps rather than the
        // cell itself, since the cell has no visible box of its own.
        today: "[&>button]:bg-accent [&>button]:text-accent-foreground",
        selected:
          "[&>button]:bg-primary [&>button]:text-primary-foreground [&>button]:hover:bg-primary [&>button]:hover:text-primary-foreground",
        outside: "text-muted-foreground opacity-50 aria-selected:text-muted-foreground",
        disabled: "text-muted-foreground opacity-50",
        hidden: "invisible",
        ...classNames,
      }}
      components={{
        Chevron: ({ orientation, className: chevronClassName, ...chevronProps }) => {
          const Icon = orientation === "left" ? ChevronLeftIcon : ChevronRightIcon;
          return <Icon className={cn("size-4", chevronClassName)} {...chevronProps} />;
        },
      }}
      {...props}
    />
  );
}

export { Calendar };
