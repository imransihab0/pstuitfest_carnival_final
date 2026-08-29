import { IsEmail, IsNotEmpty, IsString, Matches, MaxLength, MinLength } from 'class-validator';

export class RegisterDto {
  @IsEmail({}, { message: 'A valid email is required.' })
  @MaxLength(255)
  email!: string;

  @Matches(/^\+?[0-9]{10,15}$/, { message: 'Phone must be 10-15 digits, optionally +-prefixed.' })
  phone!: string;

  @IsString()
  @MinLength(3)
  @MaxLength(50)
  @Matches(/^[a-zA-Z0-9_]+$/, { message: 'Username may contain letters, digits and underscores.' })
  username!: string;

  @IsString()
  @IsNotEmpty()
  @MaxLength(100)
  displayName!: string;

  // 12 characters minimum, and no composition rules. Length beats forced
  // symbol classes: NIST dropped the latter because they push users toward
  // predictable substitutions without adding real entropy.
  @IsString()
  @MinLength(12, { message: 'Password must be at least 12 characters.' })
  @MaxLength(200)
  password!: string;

  /**
   * Exactly 6 digits. A PIN is deliberately low-entropy — it is a second factor
   * on a device the user already holds, not a standalone secret, which is why
   * the rate limit on PIN verification is what makes it safe.
   */
  @Matches(/^[0-9]{6}$/, { message: 'PIN must be exactly 6 digits.' })
  pin!: string;
}

export class LoginDto {
  /** Email, username or phone. */
  @IsString()
  @IsNotEmpty()
  @MaxLength(255)
  identifier!: string;

  @IsString()
  @IsNotEmpty()
  @MaxLength(200)
  password!: string;
}

export class VerifyPinDto {
  @Matches(/^[0-9]{6}$/, { message: 'PIN must be exactly 6 digits.' })
  pin!: string;
}

export class RefreshDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(200)
  refreshToken!: string;
}
