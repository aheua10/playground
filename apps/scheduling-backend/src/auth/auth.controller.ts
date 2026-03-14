import { Body, Controller, Post, Get, Req, UseGuards } from "@nestjs/common";
import { ApiTags } from "@nestjs/swagger";
import { AuthService } from "./auth.service";
import {
  LoginCredentials,
  RegisterCredentials,
  GoogleTokenDto,
} from "./Credentials";
import { UserInfo } from "./UserInfo";
import { Public } from "../decorators/public.decorator";

@ApiTags("auth")
@Controller("auth")
export class AuthController {
  constructor(private readonly authService: AuthService) {}

  @Public()
  @Post("login")
  async login(@Body() body: LoginCredentials): Promise<UserInfo> {
    return this.authService.loginWithEmail(body.email, body.password);
  }

  @Public()
  @Post("register")
  async register(@Body() body: RegisterCredentials): Promise<UserInfo> {
    return this.authService.register(body.email, body.password, body.name);
  }

  @Public()
  @Post("google")
  async googleLogin(@Body() body: GoogleTokenDto): Promise<UserInfo> {
    // The frontend sends the Google ID token; we decode it here
    // In production, verify the token with Google's API
    const decoded = JSON.parse(
      Buffer.from(body.token.split(".")[1], "base64").toString()
    );
    return this.authService.loginWithGoogle({
      email: decoded.email,
      name: decoded.name || decoded.email,
      googleId: decoded.sub,
    });
  }

  @Get("me")
  async me(@Req() req: any): Promise<UserInfo> {
    return {
      id: req.user.id,
      email: req.user.email,
      name: req.user.name,
      role: req.user.role,
    };
  }
}
