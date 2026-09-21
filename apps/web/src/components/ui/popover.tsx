import { Popover as PopoverPrimitive } from "radix-ui";
import * as React from "react";
import { cn } from "@/lib/utils";

function Popover({ ...props }: React.ComponentProps<typeof PopoverPrimitive.Root>) {
  return <PopoverPrimitive.Root data-slot="popover" {...props} />;
}

// `forwardRef`, not a plain function (unlike `PopoverAnchor` below): issue
// #440's placement needs the trigger's own DOM node to measure
// `getBoundingClientRect()` against — the exact node Radix's own anchor
// tracking already captures internally (`PopoverPrimitive.Trigger`'s own
// `composedTriggerRef`), so forwarding a ref here reaches it via the
// identical mechanism rather than adding a second one.
const PopoverTrigger = React.forwardRef<
  React.ComponentRef<typeof PopoverPrimitive.Trigger>,
  React.ComponentPropsWithoutRef<typeof PopoverPrimitive.Trigger>
>(function PopoverTrigger(props, ref) {
  return <PopoverPrimitive.Trigger ref={ref} data-slot="popover-trigger" {...props} />;
});

function PopoverAnchor({ ...props }: React.ComponentProps<typeof PopoverPrimitive.Anchor>) {
  return <PopoverPrimitive.Anchor data-slot="popover-anchor" {...props} />;
}

// `forwardRef` for the identical reason `PopoverTrigger` above is one:
// issue #440's placement measures the card's own actual rendered size
// (`getBoundingClientRect()`) before choosing where it opens, which needs
// this content node itself, not just the trigger's.
const PopoverContent = React.forwardRef<
  React.ComponentRef<typeof PopoverPrimitive.Content>,
  React.ComponentPropsWithoutRef<typeof PopoverPrimitive.Content>
>(function PopoverContent({ className, align = "start", sideOffset = 4, ...props }, ref) {
  return (
    <PopoverPrimitive.Portal>
      <PopoverPrimitive.Content
        ref={ref}
        data-slot="popover-content"
        align={align}
        sideOffset={sideOffset}
        className={cn("z-[60]", className)}
        {...props}
      />
    </PopoverPrimitive.Portal>
  );
});

export { Popover, PopoverAnchor, PopoverContent, PopoverTrigger };
