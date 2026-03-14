import React from "react";
import { Outlet, useNavigate, useLocation } from "react-router-dom";
import {
  AppBar,
  Toolbar,
  Typography,
  Button,
  Box,
  Container,
} from "@mui/material";
import CalendarMonthIcon from "@mui/icons-material/CalendarMonth";
import ListAltIcon from "@mui/icons-material/ListAlt";
import LogoutIcon from "@mui/icons-material/Logout";

export default function Layout() {
  const navigate = useNavigate();
  const location = useLocation();

  const handleLogout = () => {
    localStorage.removeItem("token");
    localStorage.removeItem("user");
    navigate("/login");
  };

  const user = JSON.parse(localStorage.getItem("user") || "{}");

  return (
    <Box sx={{ display: "flex", flexDirection: "column", minHeight: "100vh" }}>
      <AppBar position="static">
        <Toolbar>
          <Typography variant="h6" sx={{ flexGrow: 0, mr: 4 }}>
            Schedule Coordinator
          </Typography>
          <Button
            color="inherit"
            startIcon={<CalendarMonthIcon />}
            onClick={() => navigate("/calendar")}
            sx={{
              fontWeight:
                location.pathname === "/calendar" ? "bold" : "normal",
            }}
          >
            My Calendar
          </Button>
          <Button
            color="inherit"
            startIcon={<ListAltIcon />}
            onClick={() => navigate("/schedule-plans")}
            sx={{
              fontWeight: location.pathname.startsWith("/schedule-plans")
                ? "bold"
                : "normal",
            }}
          >
            Schedule Plans
          </Button>
          <Box sx={{ flexGrow: 1 }} />
          <Typography variant="body2" sx={{ mr: 2 }}>
            {user.name || user.email}
          </Typography>
          <Button
            color="inherit"
            startIcon={<LogoutIcon />}
            onClick={handleLogout}
          >
            Logout
          </Button>
        </Toolbar>
      </AppBar>
      <Container maxWidth="lg" sx={{ mt: 3, mb: 3, flexGrow: 1 }}>
        <Outlet />
      </Container>
    </Box>
  );
}
