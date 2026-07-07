import { TooltipProvider } from "@/components/ui/tooltip";
import { SidebarInset, SidebarProvider } from "@/components/ui/sidebar";
import { Toaster } from "@/components/ui/sonner";
import { Skeleton } from "@/components/ui/skeleton";
import { AppSidebar } from "@/components/app-sidebar";
import { AppScaleProvider } from "@/lib/app-scale";
import { CourseStoreProvider } from "@/lib/course-store";
import { ProfileProvider, useProfile } from "@/lib/profile";
import { useRoute, type Route } from "@/lib/router";
import { ThemeProvider, useTheme } from "@/lib/theme";
import { CourseScreen } from "@/screens/course";
import { LibraryScreen } from "@/screens/library";
import { OnboardingScreen } from "@/screens/onboarding";
import { SettingsScreen } from "@/screens/settings";
import { WizardScreen } from "@/screens/wizard";

function ScreenFor({ route }: { route: Route }) {
  switch (route.view) {
    case "library":
      return <LibraryScreen />;
    case "settings":
      return <SettingsScreen />;
    case "course":
      return <CourseScreen />;
    case "wizard":
      return <WizardScreen />;
  }
}

function AppContent() {
  const { profile, loading, error } = useProfile();
  const { route } = useRoute();

  if (loading) {
    return (
      <div className="grid min-h-dvh place-items-center">
        <Skeleton className="h-8 w-40" />
      </div>
    );
  }

  if (error !== undefined || profile === undefined) {
    return (
      <div className="grid min-h-dvh place-items-center p-8">
        <div className="max-w-sm text-center">
          <h1 className="text-lg font-semibold">Can’t reach the daemon</h1>
          <p className="mt-2 text-sm text-pretty text-muted-foreground">
            {error ?? "The Overlearn daemon did not respond."}
          </p>
        </div>
      </div>
    );
  }

  if (profile.onboardingState !== "done") {
    return <OnboardingScreen />;
  }

  const courseId =
    route.view === "course" || route.view === "wizard"
      ? route.courseId
      : undefined;

  const shell = (
    <SidebarProvider>
      <AppSidebar route={route} />
      <SidebarInset className="isolate min-w-0">
        <ScreenFor route={route} />
      </SidebarInset>
    </SidebarProvider>
  );

  return courseId !== undefined ? (
    <CourseStoreProvider courseId={courseId}>{shell}</CourseStoreProvider>
  ) : (
    shell
  );
}

function ThemedToaster() {
  const { resolved } = useTheme();
  return <Toaster theme={resolved} position="bottom-right" />;
}

export function App() {
  return (
    <AppScaleProvider>
      <ThemeProvider>
        <TooltipProvider delayDuration={300}>
          <ProfileProvider>
            <AppContent />
            <ThemedToaster />
          </ProfileProvider>
        </TooltipProvider>
      </ThemeProvider>
    </AppScaleProvider>
  );
}
