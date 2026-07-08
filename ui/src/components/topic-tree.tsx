import { ChevronRight } from "lucide-react";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import {
  SidebarMenu,
  SidebarMenuItem,
  SidebarMenuSub,
  SidebarMenuSubButton,
  SidebarMenuSubItem,
} from "@/components/ui/sidebar";
import type { TopicNode } from "@/lib/types";

type TopicTreeProps = {
  topics: TopicNode[];
  disabled?: boolean;
  onNavigate: (path: string) => void;
  onSelectTopic: (path: string) => void;
};

function containsCurrent(topic: TopicNode): boolean {
  return topic.current || topic.children.some(containsCurrent);
}

function TopicBranch({
  topic,
  disabled,
  onNavigate,
  onSelectTopic,
}: {
  topic: TopicNode;
  disabled: boolean;
  onNavigate: (path: string) => void;
  onSelectTopic: (path: string) => void;
}) {
  const selectOrNavigate = () => {
    if (disabled) {
      return;
    }

    if (topic.state === "frontier") {
      onNavigate(topic.path);
      return;
    }

    onSelectTopic(topic.path);
  };

  if (topic.children.length === 0) {
    return (
      <SidebarMenuSubItem>
        <SidebarMenuSubButton
          asChild
          isActive={topic.current}
          aria-disabled={disabled}
        >
          <button
            type="button"
            className="w-full"
            onClick={selectOrNavigate}
          >
            <span className="truncate">{topic.title}</span>
          </button>
        </SidebarMenuSubButton>
      </SidebarMenuSubItem>
    );
  }

  return (
    <SidebarMenuSubItem>
      <Collapsible defaultOpen={containsCurrent(topic)} className="group/branch">
        <div className="flex items-center">
          <SidebarMenuSubButton
            asChild
            isActive={topic.current}
            aria-disabled={disabled}
            className="flex-1"
          >
            <button
              type="button"
              onClick={selectOrNavigate}
            >
              <span className="truncate">{topic.title}</span>
            </button>
          </SidebarMenuSubButton>
          <CollapsibleTrigger asChild>
            <button
              type="button"
              className="flex size-6 shrink-0 items-center justify-center rounded-md text-sidebar-foreground/60 hover:bg-sidebar-accent"
              aria-label={`Toggle ${topic.title}`}
            >
              <ChevronRight className="size-4 transition-transform group-data-[state=open]/branch:rotate-90" />
            </button>
          </CollapsibleTrigger>
        </div>
        <CollapsibleContent>
          <SidebarMenuSub className="mr-0 pr-0">
            {topic.children.map((child) => (
              <TopicBranch
                key={child.path}
                topic={child}
                disabled={disabled}
                onNavigate={onNavigate}
                onSelectTopic={onSelectTopic}
              />
            ))}
          </SidebarMenuSub>
        </CollapsibleContent>
      </Collapsible>
    </SidebarMenuSubItem>
  );
}

export function TopicTree({
  topics,
  disabled = false,
  onNavigate,
  onSelectTopic,
}: TopicTreeProps) {
  if (topics.length === 0) {
    return (
      <p className="px-2 py-1.5 text-sm text-muted-foreground">No topics yet.</p>
    );
  }

  return (
    <SidebarMenu>
      <SidebarMenuItem>
        <SidebarMenuSub className="mx-0 border-none px-1.5">
          {topics.map((topic) => (
            <TopicBranch
              key={topic.path}
              topic={topic}
              disabled={disabled}
              onNavigate={onNavigate}
              onSelectTopic={onSelectTopic}
            />
          ))}
        </SidebarMenuSub>
      </SidebarMenuItem>
    </SidebarMenu>
  );
}
