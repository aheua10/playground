import React, { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import {
  Box,
  Typography,
  TextField,
  Button,
  Card,
  CardContent,
  Checkbox,
  List,
  ListItem,
  ListItemText,
  ListItemIcon,
  Alert,
} from "@mui/material";
import { createSchedulePlan, getUsers } from "../services/api";

interface UserOption {
  id: string;
  name: string;
  email: string;
}

export default function CreatePlanPage() {
  const navigate = useNavigate();
  const [name, setName] = useState("");
  const [startDate, setStartDate] = useState("");
  const [endDate, setEndDate] = useState("");
  const [maxHomeDays, setMaxHomeDays] = useState(5);
  const [minWorkDays, setMinWorkDays] = useState(15);
  const [selectedUsers, setSelectedUsers] = useState<string[]>([]);
  const [users, setUsers] = useState<UserOption[]>([]);
  const [error, setError] = useState("");

  useEffect(() => {
    getUsers()
      .then((res) => setUsers(res.data))
      .catch(console.error);
  }, []);

  const toggleUser = (userId: string) => {
    setSelectedUsers((prev) =>
      prev.includes(userId)
        ? prev.filter((id) => id !== userId)
        : [...prev, userId]
    );
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError("");

    if (selectedUsers.length === 0) {
      setError("Please select at least one member");
      return;
    }

    try {
      const res = await createSchedulePlan({
        name,
        startDate,
        endDate,
        maxHomeDays,
        minWorkDays,
        memberUserIds: selectedUsers,
      });
      navigate(`/schedule-plans/${res.data.id}`);
    } catch (err: any) {
      setError(err.response?.data?.message || "Failed to create plan");
    }
  };

  return (
    <Box>
      <Typography variant="h5" sx={{ mb: 3 }}>
        Create Schedule Plan
      </Typography>

      {error && (
        <Alert severity="error" sx={{ mb: 2 }}>
          {error}
        </Alert>
      )}

      <form onSubmit={handleSubmit}>
        <Card sx={{ mb: 3 }}>
          <CardContent>
            <Typography variant="h6" sx={{ mb: 2 }}>
              Plan Details
            </Typography>
            <TextField
              fullWidth
              label="Plan Name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              required
              sx={{ mb: 2 }}
            />
            <Box sx={{ display: "flex", gap: 2, mb: 2 }}>
              <TextField
                label="Start Date"
                type="date"
                value={startDate}
                onChange={(e) => setStartDate(e.target.value)}
                required
                InputLabelProps={{ shrink: true }}
                fullWidth
              />
              <TextField
                label="End Date"
                type="date"
                value={endDate}
                onChange={(e) => setEndDate(e.target.value)}
                required
                InputLabelProps={{ shrink: true }}
                fullWidth
              />
            </Box>
            <Box sx={{ display: "flex", gap: 2 }}>
              <TextField
                label="Max Home Days"
                type="number"
                value={maxHomeDays}
                onChange={(e) => setMaxHomeDays(Number(e.target.value))}
                required
                inputProps={{ min: 0 }}
                fullWidth
              />
              <TextField
                label="Min Work Days"
                type="number"
                value={minWorkDays}
                onChange={(e) => setMinWorkDays(Number(e.target.value))}
                required
                inputProps={{ min: 0 }}
                fullWidth
              />
            </Box>
          </CardContent>
        </Card>

        <Card sx={{ mb: 3 }}>
          <CardContent>
            <Typography variant="h6" sx={{ mb: 1 }}>
              Select Members
            </Typography>
            <Typography variant="body2" color="text.secondary" sx={{ mb: 1 }}>
              Choose the team members for this schedule plan.
            </Typography>
            <List>
              {users.map((user) => (
                <ListItem
                  key={user.id}
                  dense
                  button
                  onClick={() => toggleUser(user.id)}
                >
                  <ListItemIcon>
                    <Checkbox
                      edge="start"
                      checked={selectedUsers.includes(user.id)}
                    />
                  </ListItemIcon>
                  <ListItemText
                    primary={user.name}
                    secondary={user.email}
                  />
                </ListItem>
              ))}
            </List>
          </CardContent>
        </Card>

        <Button type="submit" variant="contained" size="large">
          Create Schedule Plan
        </Button>
      </form>
    </Box>
  );
}
