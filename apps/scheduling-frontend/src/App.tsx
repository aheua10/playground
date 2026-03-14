import React from "react";
import { Routes, Route, Navigate } from "react-router-dom";
import { ThemeProvider, createTheme, CssBaseline } from "@mui/material";
import LoginPage from "./pages/LoginPage";
import CalendarPage from "./pages/CalendarPage";
import SchedulePlansPage from "./pages/SchedulePlansPage";
import SchedulePlanDetailPage from "./pages/SchedulePlanDetailPage";
import CreatePlanPage from "./pages/CreatePlanPage";
import Layout from "./components/Layout";

const theme = createTheme({
  palette: {
    primary: { main: "#20a4f3" },
    secondary: { main: "#7950ed" },
    error: { main: "#e93c51" },
    warning: { main: "#f6aa50" },
    success: { main: "#31c587" },
  },
});

function PrivateRoute({ children }: { children: React.ReactElement }) {
  const token = localStorage.getItem("token");
  return token ? children : <Navigate to="/login" />;
}

function App() {
  return (
    <ThemeProvider theme={theme}>
      <CssBaseline />
      <Routes>
        <Route path="/login" element={<LoginPage />} />
        <Route
          path="/"
          element={
            <PrivateRoute>
              <Layout />
            </PrivateRoute>
          }
        >
          <Route index element={<Navigate to="/calendar" />} />
          <Route path="calendar" element={<CalendarPage />} />
          <Route path="schedule-plans" element={<SchedulePlansPage />} />
          <Route
            path="schedule-plans/new"
            element={<CreatePlanPage />}
          />
          <Route
            path="schedule-plans/:id"
            element={<SchedulePlanDetailPage />}
          />
        </Route>
      </Routes>
    </ThemeProvider>
  );
}

export default App;
