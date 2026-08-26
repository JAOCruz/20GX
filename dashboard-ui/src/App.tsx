import { Routes, Route, NavLink } from "react-router-dom";
import { CalendarClock, Gamepad2, Film, Mic, ListVideo, TvMinimalPlay } from "lucide-react";
import { useEffect } from "react";
import { DashboardProvider, useDashboardStore } from "@/hooks/useDashboardStore";
import { GamesPage } from "@/pages/GamesPage";
import { ProcessedPage } from "@/pages/ProcessedPage";
import { RecordingsPage } from "@/pages/RecordingsPage";
import { SchedulePage } from "@/pages/SchedulePage";
import { SetsPage } from "@/pages/SetsPage";
import { SetDetailPage } from "@/pages/SetDetailPage";
import { UploadsPage } from "@/pages/UploadsPage";
import { getConfig } from "@/lib/api";
import { ErrorBoundary } from "@/components/ErrorBoundary";

function Navigation() {
  return (
    <nav className="border-b border-border bg-card px-4 py-2">
      <ul className="flex gap-4">
        <li>
          <NavLink
            to="/"
            className={({ isActive }) =>
              `flex items-center gap-2 rounded-md px-3 py-2 text-sm font-medium transition-colors ${
                isActive
                  ? "bg-primary text-primary-foreground"
                  : "text-muted-foreground hover:bg-muted hover:text-foreground"
              }`
            }
            end
          >
            <Gamepad2 className="h-4 w-4" />
            Juegos
          </NavLink>
        </li>
        <li>
          <NavLink
            to="/sets"
            className={({ isActive }) =>
              `flex items-center gap-2 rounded-md px-3 py-2 text-sm font-medium transition-colors ${
                isActive
                  ? "bg-primary text-primary-foreground"
                  : "text-muted-foreground hover:bg-muted hover:text-foreground"
              }`
            }
          >
            <ListVideo className="h-4 w-4" />
            Sets
          </NavLink>
        </li>
        <li>
          <NavLink
            to="/calendario"
            className={({ isActive }) =>
              `flex items-center gap-2 rounded-md px-3 py-2 text-sm font-medium transition-colors ${
                isActive
                  ? "bg-primary text-primary-foreground"
                  : "text-muted-foreground hover:bg-muted hover:text-foreground"
              }`
            }
          >
            <CalendarClock className="h-4 w-4" />
            Calendario
          </NavLink>
        </li>
        <li>
          <NavLink
            to="/processed"
            className={({ isActive }) =>
              `flex items-center gap-2 rounded-md px-3 py-2 text-sm font-medium transition-colors ${
                isActive
                  ? "bg-primary text-primary-foreground"
                  : "text-muted-foreground hover:bg-muted hover:text-foreground"
              }`
            }
          >
            <Film className="h-4 w-4" />
            Procesados
          </NavLink>
        </li>
        <li>
          <NavLink
            to="/subidos"
            className={({ isActive }) =>
              `flex items-center gap-2 rounded-md px-3 py-2 text-sm font-medium transition-colors ${
                isActive
                  ? "bg-primary text-primary-foreground"
                  : "text-muted-foreground hover:bg-muted hover:text-foreground"
              }`
            }
          >
            <TvMinimalPlay className="h-4 w-4" />
            Subidos
          </NavLink>
        </li>
        <li>
          <NavLink
            to="/recordings"
            className={({ isActive }) =>
              `flex items-center gap-2 rounded-md px-3 py-2 text-sm font-medium transition-colors ${
                isActive
                  ? "bg-primary text-primary-foreground"
                  : "text-muted-foreground hover:bg-muted hover:text-foreground"
              }`
            }
          >
            <Mic className="h-4 w-4" />
            Grabaciones
          </NavLink>
        </li>
      </ul>
    </nav>
  );
}

function ConfigLoader() {
  const { setGuildId, setChannelId, setDiscordHistory } = useDashboardStore();

  useEffect(() => {
    getConfig()
      .then((config) => {
        setGuildId(config.discordGuildId || "");
        setChannelId(config.discordChannelId || "");
        setDiscordHistory(config.history || []);
      })
      .catch(() => {
        // Ignorar errores de carga de config
      });
  }, [setGuildId, setChannelId, setDiscordHistory]);

  return null;
}

function App() {
  return (
    <DashboardProvider>
      <ErrorBoundary>
        <ConfigLoader />
        <div className="min-h-screen bg-melee-blue">
          <Navigation />
          <main>
            <Routes>
              <Route path="/" element={<GamesPage />} />
              <Route path="/sets" element={<SetsPage />} />
              <Route path="/sets/:id" element={<SetDetailPage />} />
              <Route path="/calendario" element={<SchedulePage />} />
              <Route path="/processed" element={<ProcessedPage />} />
              <Route path="/subidos" element={<UploadsPage />} />
              <Route path="/recordings" element={<RecordingsPage />} />
            </Routes>
          </main>
        </div>
      </ErrorBoundary>
    </DashboardProvider>
  );
}

export default App;
