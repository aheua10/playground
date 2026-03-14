import React, { useEffect, useState } from "react";
import { useParams } from "react-router-dom";
import {
  Box,
  Typography,
  Button,
  Alert,
  Chip,
  Table,
  TableBody,
  TableCell,
  TableContainer,
  TableHead,
  TableRow,
  Paper,
  Tooltip,
  CircularProgress,
} from "@mui/material";
import PlayArrowIcon from "@mui/icons-material/PlayArrow";
import {
  getSchedulePlan,
  generateSchedule,
  updateAssignment,
} from "../services/api";

interface Assignment {
  id: string;
  userId: string;
  date: string;
  isHome: boolean;
  isManualOverride: boolean;
}

interface Member {
  userId: string;
  user: { id: string; name: string; email: string };
}

interface Plan {
  id: string;
  name: string;
  startDate: string;
  endDate: string;
  maxHomeDays: number;
  minWorkDays: number;
  members: Member[];
  assignments: Assignment[];
}

export default function SchedulePlanDetailPage() {
  const { id } = useParams<{ id: string }>();
  const [plan, setPlan] = useState<Plan | null>(null);
  const [generating, setGenerating] = useState(false);
  const [genResult, setGenResult] = useState<any>(null);
  const [error, setError] = useState("");

  const load = async () => {
    if (!id) return;
    try {
      const res = await getSchedulePlan(id);
      setPlan(res.data);
    } catch (err) {
      console.error("Failed to load plan", err);
    }
  };

  useEffect(() => {
    load();
  }, [id]); // eslint-disable-line react-hooks/exhaustive-deps

  const handleGenerate = async () => {
    if (!id) return;
    setGenerating(true);
    setError("");
    setGenResult(null);
    try {
      const res = await generateSchedule(id);
      setGenResult(res.data);
      await load();
    } catch (err: any) {
      setError(err.response?.data?.message || "Generation failed");
    } finally {
      setGenerating(false);
    }
  };

  const handleToggleAssignment = async (assignment: Assignment) => {
    if (!id) return;
    try {
      await updateAssignment(id, assignment.id, !assignment.isHome);
      await load();
    } catch (err) {
      console.error("Failed to update assignment", err);
    }
  };

  if (!plan)
    return (
      <Box sx={{ display: "flex", justifyContent: "center", mt: 4 }}>
        <CircularProgress />
      </Box>
    );

  // Build schedule grid
  const dates: string[] = [];
  const current = new Date(plan.startDate);
  const end = new Date(plan.endDate);
  while (current <= end) {
    dates.push(current.toISOString().split("T")[0]);
    current.setDate(current.getDate() + 1);
  }

  // Assignment lookup: `${userId}-${dateStr}` -> Assignment
  const assignmentMap = new Map<string, Assignment>();
  for (const a of plan.assignments) {
    const dateStr = new Date(a.date).toISOString().split("T")[0];
    assignmentMap.set(`${a.userId}-${dateStr}`, a);
  }

  const formatDate = (d: string) => {
    const date = new Date(d + "T00:00:00");
    return date.toLocaleDateString("en-US", {
      month: "short",
      day: "numeric",
    });
  };

  const getDayOfWeek = (d: string) => {
    const date = new Date(d + "T00:00:00");
    return date.toLocaleDateString("en-US", { weekday: "short" });
  };

  return (
    <Box>
      <Typography variant="h5" sx={{ mb: 1 }}>
        {plan.name}
      </Typography>
      <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
        {new Date(plan.startDate).toLocaleDateString()} —{" "}
        {new Date(plan.endDate).toLocaleDateString()}
      </Typography>

      <Box sx={{ display: "flex", gap: 1, mb: 2, flexWrap: "wrap" }}>
        <Chip
          label={`Max ${plan.maxHomeDays} home days`}
          color="warning"
          size="small"
        />
        <Chip
          label={`Min ${plan.minWorkDays} work days`}
          color="info"
          size="small"
        />
        <Chip
          label={`${plan.members.length} members`}
          size="small"
        />
      </Box>

      <Button
        variant="contained"
        startIcon={
          generating ? <CircularProgress size={20} /> : <PlayArrowIcon />
        }
        onClick={handleGenerate}
        disabled={generating}
        sx={{ mb: 2 }}
      >
        {generating ? "Generating..." : "Generate Schedule"}
      </Button>

      {error && (
        <Alert severity="error" sx={{ mb: 2 }}>
          {error}
        </Alert>
      )}

      {genResult && (
        <Alert severity="info" sx={{ mb: 2 }}>
          Generated {genResult.assignmentsCreated} assignments for{" "}
          {genResult.memberCount} members over {genResult.totalDays} days.
          {genResult.conflicts?.length > 0 && (
            <Box sx={{ mt: 1 }}>
              <strong>Conflicts:</strong>
              {genResult.conflicts.map((c: any, i: number) => (
                <Box key={i}>— {c.reason}</Box>
              ))}
            </Box>
          )}
        </Alert>
      )}

      {plan.assignments.length > 0 && (
        <>
          <Typography variant="h6" sx={{ mb: 1 }}>
            Schedule Grid
          </Typography>
          <Typography variant="body2" color="text.secondary" sx={{ mb: 1 }}>
            Click a cell to toggle between home/work. Green = at work, Red = at
            home.
          </Typography>
          <TableContainer component={Paper} sx={{ maxHeight: 600 }}>
            <Table size="small" stickyHeader>
              <TableHead>
                <TableRow>
                  <TableCell
                    sx={{
                      fontWeight: "bold",
                      position: "sticky",
                      left: 0,
                      bgcolor: "white",
                      zIndex: 3,
                    }}
                  >
                    Member
                  </TableCell>
                  {dates.map((d) => (
                    <TableCell
                      key={d}
                      align="center"
                      sx={{ fontSize: "0.7rem", minWidth: 50, px: 0.5 }}
                    >
                      {getDayOfWeek(d)}
                      <br />
                      {formatDate(d)}
                    </TableCell>
                  ))}
                  <TableCell align="center" sx={{ fontWeight: "bold" }}>
                    Home
                  </TableCell>
                  <TableCell align="center" sx={{ fontWeight: "bold" }}>
                    Work
                  </TableCell>
                </TableRow>
              </TableHead>
              <TableBody>
                {plan.members.map((member) => {
                  let homeCount = 0;
                  let workCount = 0;
                  return (
                    <TableRow key={member.userId}>
                      <TableCell
                        sx={{
                          fontWeight: "bold",
                          position: "sticky",
                          left: 0,
                          bgcolor: "white",
                          zIndex: 1,
                          whiteSpace: "nowrap",
                        }}
                      >
                        {member.user.name}
                      </TableCell>
                      {dates.map((d) => {
                        const a = assignmentMap.get(
                          `${member.userId}-${d}`
                        );
                        if (a?.isHome) homeCount++;
                        else if (a) workCount++;
                        return (
                          <Tooltip
                            key={d}
                            title={
                              a
                                ? `${a.isHome ? "Home" : "Work"}${a.isManualOverride ? " (manual)" : ""} — Click to toggle`
                                : "No assignment"
                            }
                          >
                            <TableCell
                              align="center"
                              onClick={() => a && handleToggleAssignment(a)}
                              sx={{
                                cursor: a ? "pointer" : "default",
                                bgcolor: a
                                  ? a.isHome
                                    ? "#e93c51"
                                    : "#31c587"
                                  : "transparent",
                                color: a ? "white" : "inherit",
                                fontSize: "0.7rem",
                                px: 0.5,
                                border: a?.isManualOverride
                                  ? "2px solid #7950ed"
                                  : undefined,
                                "&:hover": a
                                  ? { opacity: 0.8 }
                                  : {},
                              }}
                            >
                              {a ? (a.isHome ? "H" : "W") : "—"}
                            </TableCell>
                          </Tooltip>
                        );
                      })}
                      <TableCell align="center">
                        <Chip label={homeCount} size="small" color="error" />
                      </TableCell>
                      <TableCell align="center">
                        <Chip
                          label={workCount}
                          size="small"
                          color="success"
                        />
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          </TableContainer>
        </>
      )}
    </Box>
  );
}
