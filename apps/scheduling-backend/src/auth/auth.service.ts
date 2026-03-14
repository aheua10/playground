import {
  Injectable,
  UnauthorizedException,
  ConflictException,
} from "@nestjs/common";
import { UserService } from "../user/user.service";
import { PasswordService } from "./password.service";
import { TokenService } from "./token.service";
import { UserInfo } from "./UserInfo";

@Injectable()
export class AuthService {
  constructor(
    private readonly userService: UserService,
    private readonly passwordService: PasswordService,
    private readonly tokenService: TokenService
  ) {}

  async loginWithEmail(email: string, password: string): Promise<UserInfo> {
    const user = await this.userService.findByEmail(email);
    if (!user || !user.password) {
      throw new UnauthorizedException("Invalid credentials");
    }
    const isValid = await this.passwordService.compare(password, user.password);
    if (!isValid) {
      throw new UnauthorizedException("Invalid credentials");
    }
    const accessToken = await this.tokenService.createToken({
      id: user.id,
      email: user.email,
    });
    return {
      id: user.id,
      email: user.email,
      name: user.name,
      role: user.role,
      accessToken,
    };
  }

  async register(
    email: string,
    password: string,
    name: string
  ): Promise<UserInfo> {
    const existing = await this.userService.findByEmail(email);
    if (existing) {
      throw new ConflictException("Email already registered");
    }
    const hashedPassword = await this.passwordService.hash(password);
    const user = await this.userService.create({
      email,
      name,
      password: hashedPassword,
    });
    const accessToken = await this.tokenService.createToken({
      id: user.id,
      email: user.email,
    });
    return {
      id: user.id,
      email: user.email,
      name: user.name,
      role: user.role,
      accessToken,
    };
  }

  async loginWithGoogle(googleUser: {
    email: string;
    name: string;
    googleId: string;
  }): Promise<UserInfo> {
    let user = await this.userService.findByGoogleId(googleUser.googleId);
    if (!user) {
      user = await this.userService.findByEmail(googleUser.email);
      if (user) {
        // Link Google account to existing user
        user = await this.userService.update(user.id, {
          googleId: googleUser.googleId,
        });
      } else {
        // Create new user
        user = await this.userService.create({
          email: googleUser.email,
          name: googleUser.name,
          googleId: googleUser.googleId,
        });
      }
    }
    const accessToken = await this.tokenService.createToken({
      id: user.id,
      email: user.email,
    });
    return {
      id: user.id,
      email: user.email,
      name: user.name,
      role: user.role,
      accessToken,
    };
  }
}
