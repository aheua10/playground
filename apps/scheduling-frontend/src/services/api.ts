import axios from "axios";

const API_URL = process.env.REACT_APP_SERVER_URL || "http://localhost:3000";

const api = axios.create({
  baseURL: `${API_URL}/api`,
});

// Attach JWT token to every request
api.interceptors.request.use((config) => {
  const token = localStorage.getItem("token");
  if (token) {
    config.headers.Authorization = `Bearer ${token}`;
  }
  return config;
});

// Auth
export const loginWithEmail = (email: string, password: string) =>
  api.post("/auth/login", { email, password });

export const registerWithEmail = (
  email: string,
  password: string,
  name: string
) => api.post("/auth/register", { email, password, name });

export const loginWithGoogle = (token: string) =>
  api.post("/auth/google", { token });

export const getMe = () => api.get("/auth/me");

// Availability
export const getAvailability = (startDate: string, endDate: string) =>
  api.get("/availability", { params: { startDate, endDate } });

export const setAvailability = (
  date: string,
  urgency: "GREEN" | "YELLOW" | "RED",
  note?: string
) => api.put("/availability", { date, urgency, note });

export const deleteAvailability = (id: string) =>
  api.delete(`/availability/${id}`);

// Schedule Plans
export const getSchedulePlans = () => api.get("/schedule-plans");

export const getSchedulePlan = (id: string) =>
  api.get(`/schedule-plans/${id}`);

export const createSchedulePlan = (data: {
  name: string;
  startDate: string;
  endDate: string;
  maxHomeDays: number;
  minWorkDays: number;
  memberUserIds: string[];
}) => api.post("/schedule-plans", data);

export const updateSchedulePlan = (
  id: string,
  data: Record<string, unknown>
) => api.patch(`/schedule-plans/${id}`, data);

export const deleteSchedulePlan = (id: string) =>
  api.delete(`/schedule-plans/${id}`);

export const addMember = (planId: string, userId: string) =>
  api.post(`/schedule-plans/${planId}/members`, { userId });

export const removeMember = (planId: string, userId: string) =>
  api.delete(`/schedule-plans/${planId}/members/${userId}`);

export const generateSchedule = (planId: string) =>
  api.post(`/schedule-plans/${planId}/generate`);

export const updateAssignment = (
  planId: string,
  assignmentId: string,
  isHome: boolean
) =>
  api.patch(`/schedule-plans/${planId}/assignments/${assignmentId}`, {
    isHome,
  });

// Users
export const getUsers = () => api.get("/users");

export default api;
