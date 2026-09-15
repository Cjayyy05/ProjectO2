declare global {
  namespace Express {
    interface Request {
      auth?: {
        userId: string;
      };
      requestId: string;
    }
  }
}

export {};

