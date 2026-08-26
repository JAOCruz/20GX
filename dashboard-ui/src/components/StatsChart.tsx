import { useMemo } from "react";
import { BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer, Cell } from "recharts";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { GameInfo } from "@/types";

export function StatsChart({ games }: { games: GameInfo[] }) {
  const data = useMemo(() => {
    const counts = new Map<string, number>();
    games.forEach((g) => {
      if (g.mainPlayer?.characterName) {
        counts.set(g.mainPlayer.characterName, (counts.get(g.mainPlayer.characterName) || 0) + 1);
      }
      if (g.opponent?.characterName) {
        counts.set(g.opponent.characterName, (counts.get(g.opponent.characterName) || 0) + 1);
      }
    });
    return Array.from(counts.entries())
      .map(([name, value]) => ({ name, value }))
      .sort((a, b) => b.value - a.value)
      .slice(0, 8);
  }, [games]);

  if (games.length === 0) return null;

  return (
    <Card className="border-border bg-card">
      <CardHeader className="pb-2">
        <CardTitle className="text-lg">Top personajes</CardTitle>
      </CardHeader>
      <CardContent>
        <div className="h-64 w-full">
          <ResponsiveContainer width="100%" height="100%">
            <BarChart data={data} margin={{ top: 10, right: 10, left: 0, bottom: 30 }}>
              <XAxis dataKey="name" angle={-45} textAnchor="end" interval={0} tick={{ fill: "#94a3b8", fontSize: 12 }} />
              <YAxis tick={{ fill: "#94a3b8" }} allowDecimals={false} />
              <Tooltip
                contentStyle={{ backgroundColor: "#0f172a", borderColor: "#334155", color: "#f8fafc" }}
                itemStyle={{ color: "#ffd700" }}
              />
              <Bar dataKey="value" radius={[4, 4, 0, 0]}>
                {data.map((_, idx) => (
                  <Cell key={`cell-${idx}`} fill={idx === 0 ? "#ffd700" : "#e60012"} />
                ))}
              </Bar>
            </BarChart>
          </ResponsiveContainer>
        </div>
      </CardContent>
    </Card>
  );
}
