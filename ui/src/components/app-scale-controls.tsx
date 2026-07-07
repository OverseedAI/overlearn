import { RotateCcw, ZoomIn, ZoomOut } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { useAppScale } from "@/lib/app-scale";

export function AppScaleControls() {
  const { scale, canZoomIn, canZoomOut, zoomIn, zoomOut, resetScale } =
    useAppScale();
  const scaleLabel = `${Math.round(scale * 100)}%`;
  const isDefault = scale === 1;

  return (
    <div
      className="flex shrink-0 items-center gap-0.5"
      role="group"
      aria-label={`UI scale ${scaleLabel}`}
    >
      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            type="button"
            variant="ghost"
            size="icon"
            aria-label="Zoom out"
            disabled={!canZoomOut}
            onClick={zoomOut}
            className="size-8"
          >
            <ZoomOut className="size-4" />
          </Button>
        </TooltipTrigger>
        <TooltipContent>Zoom out</TooltipContent>
      </Tooltip>

      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            type="button"
            variant="ghost"
            size="icon"
            aria-label={`Reset zoom, currently ${scaleLabel}`}
            disabled={isDefault}
            onClick={resetScale}
            className="size-8"
          >
            <RotateCcw className="size-4" />
          </Button>
        </TooltipTrigger>
        <TooltipContent>Reset zoom ({scaleLabel})</TooltipContent>
      </Tooltip>

      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            type="button"
            variant="ghost"
            size="icon"
            aria-label="Zoom in"
            disabled={!canZoomIn}
            onClick={zoomIn}
            className="size-8"
          >
            <ZoomIn className="size-4" />
          </Button>
        </TooltipTrigger>
        <TooltipContent>Zoom in</TooltipContent>
      </Tooltip>
    </div>
  );
}
