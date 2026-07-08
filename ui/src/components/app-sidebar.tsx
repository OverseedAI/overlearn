import {
  LibraryBig,
  Moon,
  Settings2,
  Sparkles,
  Sun,
  SunMoon,
} from "lucide-react";
import { toast } from "sonner";
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
} from "@/components/ui/sidebar";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { OverlearnWordmark } from "@/components/brand";
import { TopicTree } from "@/components/topic-tree";
import { MasteryMeter } from "@/components/mastery-meter";
import { api, ApiError } from "@/lib/api";
import { useOptionalCourseStore } from "@/lib/course-store";
import { useRoute, type Route } from "@/lib/router";
import { useTheme, type ThemePreference } from "@/lib/theme";

function ThemePicker() {
  const { preference, setPreference } = useTheme();
  const icon =
    preference === "light" ? (
      <Sun className="size-4 shrink-0" />
    ) : preference === "dark" ? (
      <Moon className="size-4 shrink-0" />
    ) : (
      <SunMoon className="size-4 shrink-0" />
    );

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <SidebarMenuButton>
          {icon}
          <span>Appearance</span>
        </SidebarMenuButton>
      </DropdownMenuTrigger>
      <DropdownMenuContent side="top" align="start" className="w-40">
        <DropdownMenuRadioGroup
          value={preference}
          onValueChange={(value) => setPreference(value as ThemePreference)}
        >
          <DropdownMenuRadioItem value="system">System</DropdownMenuRadioItem>
          <DropdownMenuRadioItem value="light">Light</DropdownMenuRadioItem>
          <DropdownMenuRadioItem value="dark">Dark</DropdownMenuRadioItem>
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function CourseSection() {
  const context = useOptionalCourseStore();
  if (!context?.store.state) {
    return null;
  }

  const { store, courseId } = context;
  const { topics, mastery } = store.state!;
  const busy = store.status === "agent-working" || store.status === "wrapping-up";
  const navigateTopic = async (path: string) => {
    try {
      await api.nav(courseId, path);
    } catch (error) {
      toast.error(
        error instanceof ApiError ? error.message : "Couldn’t change topic.",
      );
    }
  };

  return (
    <>
      <SidebarGroup>
        <SidebarGroupLabel>Progress</SidebarGroupLabel>
        <SidebarGroupContent className="px-2">
          <MasteryMeter mastery={mastery} />
        </SidebarGroupContent>
      </SidebarGroup>
      <SidebarGroup>
        <SidebarGroupLabel>Topics</SidebarGroupLabel>
        <SidebarGroupContent>
          <TopicTree
            topics={topics}
            frontierDisabled={busy}
            onNavigate={(path) => void navigateTopic(path)}
          />
          <SidebarMenu>
            <SidebarMenuItem>
              <SidebarMenuButton
                disabled={busy || mastery.length === 0}
                onClick={() => void api.reviewWeak(courseId)}
              >
                <Sparkles className="size-4 shrink-0" />
                <span>Review weak spots</span>
              </SidebarMenuButton>
            </SidebarMenuItem>
          </SidebarMenu>
        </SidebarGroupContent>
      </SidebarGroup>
    </>
  );
}

export function AppSidebar({ route }: { route: Route }) {
  const { navigate } = useRoute();

  return (
    <Sidebar>
      <SidebarHeader>
        <div
          data-tauri-drag-region
          aria-hidden="true"
          className="app-sidebar-titlebar-space"
        />
        <SidebarMenu>
          <SidebarMenuItem>
            <SidebarMenuButton
              size="lg"
              onClick={() => navigate({ view: "library" })}
              aria-label="Overlearn — go to library"
            >
              <OverlearnWordmark className="px-1 text-xl" />
            </SidebarMenuButton>
          </SidebarMenuItem>
        </SidebarMenu>
      </SidebarHeader>
      <SidebarContent>
        <SidebarGroup>
          <SidebarGroupContent>
            <SidebarMenu>
              <SidebarMenuItem>
                <SidebarMenuButton
                  isActive={route.view === "library"}
                  onClick={() => navigate({ view: "library" })}
                >
                  <LibraryBig className="size-4 shrink-0" />
                  <span>Library</span>
                </SidebarMenuButton>
              </SidebarMenuItem>
              <SidebarMenuItem>
                <SidebarMenuButton
                  isActive={route.view === "settings"}
                  onClick={() => navigate({ view: "settings" })}
                >
                  <Settings2 className="size-4 shrink-0" />
                  <span>Settings</span>
                </SidebarMenuButton>
              </SidebarMenuItem>
            </SidebarMenu>
          </SidebarGroupContent>
        </SidebarGroup>
        <CourseSection />
      </SidebarContent>
      <SidebarFooter>
        <SidebarMenu>
          <SidebarMenuItem>
            <ThemePicker />
          </SidebarMenuItem>
        </SidebarMenu>
      </SidebarFooter>
    </Sidebar>
  );
}
