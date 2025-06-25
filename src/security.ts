/**
 * Security module for protecting administrative endpoints
 */

import type { Env } from "./types";

/**
 * Security configuration interface
 */
export interface SecurityConfig {
  adminToken?: string;
  enableAuth: boolean;
  allowedOrigins?: string[];
}

/**
 * Extracts Bearer token from Authorization header
 */
export function extractBearerToken(request: Request): string | null {
  const authHeader = request.headers.get("Authorization");
  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    return null;
  }
  return authHeader.substring(7); // Remove "Bearer " prefix
}

/**
 * Validates admin authentication
 */
export function validateAdminAuth(request: Request, env: Env): { isValid: boolean; error?: string } {
  // In development, allow unauthenticated access
  const environment = (globalThis as any).ENVIRONMENT || "development";
  if (environment === "development") {
    return { isValid: true };
  }

  const token = extractBearerToken(request);

  if (!token) {
    return {
      isValid: false,
      error: "Missing Authorization header. Use: Authorization: Bearer <token>",
    };
  }

  // Check against configured admin token
  const adminToken = env.ADMIN_TOKEN;
  if (!adminToken) {
    return {
      isValid: false,
      error: "Admin authentication not configured. Please set ADMIN_TOKEN environment variable.",
    };
  }

  if (token !== adminToken) {
    return {
      isValid: false,
      error: "Invalid admin token",
    };
  }

  return { isValid: true };
}

/**
 * Validates API key for read operations
 */
export function validateApiKey(request: Request, env: Env): { isValid: boolean; error?: string } {
  // API key validation for search operations (optional, but recommended for production)
  const apiKey = request.headers.get("X-API-Key");

  // If no API key is configured, allow access
  if (!env.API_KEY) {
    return { isValid: true };
  }

  if (!apiKey) {
    return {
      isValid: false,
      error: "API key required. Use: X-API-Key: <key>",
    };
  }

  if (apiKey !== env.API_KEY) {
    return {
      isValid: false,
      error: "Invalid API key",
    };
  }

  return { isValid: true };
}

/**
 * CORS validation
 */
export function validateCORS(request: Request, allowedOrigins: string[] = []): Response | null {
  const origin = request.headers.get("Origin");

  // If no origins are configured, allow all
  if (allowedOrigins.length === 0) {
    return null;
  }

  // Check if origin is allowed
  if (origin && !allowedOrigins.includes(origin)) {
    return new Response("CORS policy violation", {
      status: 403,
      headers: {
        "Content-Type": "text/plain",
        "Access-Control-Allow-Origin": "",
      },
    });
  }

  return null;
}

/**
 * Rate limiting (basic implementation using headers)
 */
export function checkRateLimit(request: Request): { isAllowed: boolean; error?: string } {
  // This is a basic rate limiting check
  // In production, you might want to use Durable Objects for more sophisticated rate limiting

  const cfConnectingIP = request.headers.get("CF-Connecting-IP");
  const cfRay = request.headers.get("CF-Ray");

  // For now, just log the request details for monitoring
  console.log(`Request from IP: ${cfConnectingIP}, Ray: ${cfRay}`);

  // Always allow for now - implement actual rate limiting based on your needs
  return { isAllowed: true };
}

/**
 * Security headers for responses
 */
export function addSecurityHeaders(response: Response): Response {
  const headers = new Headers(response.headers);

  headers.set("X-Content-Type-Options", "nosniff");
  headers.set("X-Frame-Options", "DENY");
  headers.set("X-XSS-Protection", "1; mode=block");
  headers.set("Referrer-Policy", "strict-origin-when-cross-origin");
  headers.set("Content-Security-Policy", "default-src 'self'");

  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

/**
 * Creates a standardized error response for security violations
 */
export function createSecurityErrorResponse(error: string, status: number = 401): Response {
  return addSecurityHeaders(
    new Response(
      JSON.stringify({
        success: false,
        error: "Authentication failed",
        details: error,
      }),
      {
        status,
        headers: {
          "Content-Type": "application/json",
        },
      }
    )
  );
}
