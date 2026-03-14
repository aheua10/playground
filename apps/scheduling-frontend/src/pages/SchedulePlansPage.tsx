import React, { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import {
  Box,
  Typography,
  Button,
  Card,
  CardContent,
  CardActions,
  Grid,
  Chip,
} from "@mui/material";
import AddIcon from "@mui/icons-material/Add";
import { getSchedulePlans, deleteSchedulePlan } from "../services/api";

interface SchedulePlan {
  id: string;
  name: string;
  startDate: string;
  endDate: string;
  maxHomeDays: number;
  minWorkDays: number;
  members: { user: { id: string; name: string; email: string } }[];
  _count: { assignments: number };
}

export default function SchedulePlansPage() {
  const navigate = useNavigate();
  const [plans, setPlans] = useState<SchedulePlan[]>([]);

  const load = async () => {
    try {
      const res = await getSchedulePlans();
      setPlans(res.data);
    } catch (err) {
      console.error("Failed to load plans", err);
    }
  };

  useEffect(() => {
    load();
  }, []);

  const handleDelete = async (id: string) => {
    if (!window.confirm("Delete this schedule plan?")) return;
    try {
      await deleteSchedulePlan(id);
      load();
    } catch (err) {
      console.error("Failed to delete plan", err);
    }
  };

  const formatDate = (d: string) => new Date(d).toLocaleDateString();

  return (
    <Box>
      <Box
        sx={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
          mb: 3,
        }}
      >
        <Typography variant="h5">Schedule Plans</Typography>
        <Button
          variant="contained"
          startIcon={<AddIcon />}
          onClick={() => navigate("/schedule-plans/new")}
        >
          Create Plan
        </Button>
      </Box>

      {plans.length === 0 && (
        <Typography color="text.secondary">
          No schedule plans yet. Create one to get started.
        </Typography>
      )}

      <Grid container spacing={2}>
        {plans.map((plan) => (
          <Grid item xs={12} md={6} key={plan.id}>
            <Card>
              <CardContent>
                <Typography variant="h6">{plan.name}</Typography>
                <Typography variant="body2" color="text.secondary">
                  {formatDate(plan.startDate)} — {formatDate(plan.endDate)}
                </Typography>
                <Box sx={{ mt: 1, display: "flex", gap: 1, flexWrap: "wrap" }}>
                  <Chip
                    label={`Max ${plan.maxHomeDays} home days`}
                    size="small"
                    color="warning"
                  />
                  <Chip
                    label={`Min ${plan.minWorkDays} work days`}
                    size="small"
                    color="info"
                  />
                  <Chip
                    label={`${plan.members.length} members`}
                    size="small"
                  />
                  <Chip
                    label={`${plan._count.assignments} assignments`}
                    size="small"
                    color="success"
                  />
                </Box>
              </CardContent>
              <CardActions>
                <Button
                  size="small"
                  onClick={() => navigate(`/schedule-plans/${plan.id}`)}
                >
                  View Details
                </Button>
                <Button
                  size="small"
                  color="error"
                  onClick={() => handleDelete(plan.id)}
                >
                  Delete
                </Button>
              </CardActions>
            </Card>
          </Grid>
        ))}
      </Grid>
    </Box>
  );
}
