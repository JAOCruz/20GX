import { useEffect } from "react";
import { useQuery } from "@tanstack/react-query";
import { getJob } from "@/lib/api";
import { useDashboardStore } from "./useDashboardStore";

export function useJobPoll() {
  const { currentJob, setCurrentJob, setJobLogs } = useDashboardStore();

  const jobId = currentJob?.id;
  const enabled = Boolean(jobId && currentJob?.status === "running");

  const { data } = useQuery({
    queryKey: ["job", jobId],
    queryFn: () => (jobId ? getJob(jobId) : Promise.reject("no job")),
    enabled,
    refetchInterval: 1500,
  });

  useEffect(() => {
    if (data) {
      setCurrentJob(data);
      // El panel ya muestra lastProgressLine por separado; no duplicarlo en logs.
      setJobLogs(data.progress?.log ?? "");
    }
  }, [data, setCurrentJob, setJobLogs]);

  return currentJob;
}
