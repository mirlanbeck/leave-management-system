/** GET /me (architecture §7). Дата выхода: YYYY-MM-DD. */
export interface Profile {
  id: number;
  fullName: string;
  hireDate: string;
  teamName: string | null;
  manager: { id: number; fullName: string } | null;
  isHr: boolean;
  isManager: boolean;
}

export interface LoginResult {
  accessToken: string;
  expiresAt: string;
}
