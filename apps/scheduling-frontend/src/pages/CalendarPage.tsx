import React, { useState, useEffect, useCallback } from "react";
import FullCalendar from "@fullcalendar/react";
import dayGridPlugin from "@fullcalendar/daygrid";
import interactionPlugin from "@fullcalendar/interaction";
import {
  Box,
  Typography,
  Dialog,
  DialogTitle,
  DialogContent,
  DialogActions,
  Button,
  ToggleButtonGroup,
  ToggleButton,
  TextField,
  Chip,
  Stack,
} from "@mui/material";
import { getAvailability, setAvailability } from "../services/api";

const URGENCY_COLORS: Record<string, string> = {
  GREEN: "#31c587",
  YELLOW: "#f6aa50",
  RED: "#e93c51",
};

const URGENCY_LABELS: Record<string, string> = {
  GREEN: "Available",
  YELLOW: "Prefer Home",
  RED: "Must Be Home",
};

interface AvailabilityEntry {
  id: string;
  date: string;
  urgency: "GREEN" | "YELLOW" | "RED";
  note?: string;
}

export default function CalendarPage() {
  const [entries, setEntries] = useState<AvailabilityEntry[]>([]);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [selectedDate, setSelectedDate] = useState("");
  const [selectedUrgency, setSelectedUrgency] = useState<
    "GREEN" | "YELLOW" | "RED"
  >("GREEN");
  const [note, setNote] = useState("");
  const [dateRange, setDateRange] = useState<{
    start: string;
    end: string;
  } | null>(null);

  const loadAvailability = useCallback(async () => {
    if (!dateRange) return;
    try {
      const res = await getAvailability(dateRange.start, dateRange.end);
      setEntries(res.data);
    } catch (err) {
      console.error("Failed to load availability", err);
    }
  }, [dateRange]);

  useEffect(() => {
    loadAvailability();
  }, [loadAvailability]);

  const handleDateClick = (info: { dateStr: string }) => {
    setSelectedDate(info.dateStr);
    const existing = entries.find(
      (e) => e.date.split("T")[0] === info.dateStr
    );
    setSelectedUrgency(existing?.urgency || "GREEN");
    setNote(existing?.note || "");
    setDialogOpen(true);
  };

  const handleSave = async () => {
    try {
      await setAvailability(selectedDate, selectedUrgency, note || undefined);
      setDialogOpen(false);
      await loadAvailability();
    } catch (err) {
      console.error("Failed to save availability", err);
    }
  };

  const calendarEvents = entries.map((e) => ({
    start: e.date.split("T")[0],
    allDay: true,
    display: "background",
    backgroundColor: URGENCY_COLORS[e.urgency],
    extendedProps: { urgency: e.urgency, note: e.note },
  }));

  return (
    <Box>
      <Typography variant="h5" sx={{ mb: 1 }}>
        My Availability
      </Typography>
      <Stack direction="row" spacing={2} sx={{ mb: 2 }}>
        {Object.entries(URGENCY_LABELS).map(([key, label]) => (
          <Chip
            key={key}
            label={label}
            sx={{
              bgcolor: URGENCY_COLORS[key],
              color: "white",
              fontWeight: "bold",
            }}
          />
        ))}
      </Stack>
      <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
        Click on a day to set your availability. Green is the default
        (available for work).
      </Typography>

      <FullCalendar
        plugins={[dayGridPlugin, interactionPlugin]}
        initialView="dayGridMonth"
        dateClick={handleDateClick}
        events={calendarEvents}
        datesSet={(arg) =>
          setDateRange({
            start: arg.startStr,
            end: arg.endStr,
          })
        }
        height="auto"
      />

      <Dialog open={dialogOpen} onClose={() => setDialogOpen(false)}>
        <DialogTitle>Set Availability — {selectedDate}</DialogTitle>
        <DialogContent>
          <Typography variant="body2" sx={{ mb: 2 }}>
            How available are you on this day?
          </Typography>
          <ToggleButtonGroup
            value={selectedUrgency}
            exclusive
            onChange={(_, val) => val && setSelectedUrgency(val)}
            fullWidth
            sx={{ mb: 2 }}
          >
            <ToggleButton
              value="GREEN"
              sx={{
                "&.Mui-selected": {
                  bgcolor: "#31c587",
                  color: "white",
                  "&:hover": { bgcolor: "#28a872" },
                },
              }}
            >
              Available
            </ToggleButton>
            <ToggleButton
              value="YELLOW"
              sx={{
                "&.Mui-selected": {
                  bgcolor: "#f6aa50",
                  color: "white",
                  "&:hover": { bgcolor: "#e09940" },
                },
              }}
            >
              Prefer Home
            </ToggleButton>
            <ToggleButton
              value="RED"
              sx={{
                "&.Mui-selected": {
                  bgcolor: "#e93c51",
                  color: "white",
                  "&:hover": { bgcolor: "#d33245" },
                },
              }}
            >
              Must Be Home
            </ToggleButton>
          </ToggleButtonGroup>
          <TextField
            fullWidth
            label="Note (optional)"
            value={note}
            onChange={(e) => setNote(e.target.value)}
            multiline
            rows={2}
          />
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setDialogOpen(false)}>Cancel</Button>
          <Button onClick={handleSave} variant="contained">
            Save
          </Button>
        </DialogActions>
      </Dialog>
    </Box>
  );
}
