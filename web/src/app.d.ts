/// <reference types="@sveltejs/kit" />

declare namespace App {
  interface PageData {
    meta?: {
      title?: string;
      description?: string;
    };
  }

  interface Error {
    message: string;
    stack?: string;
    code?: string | number;
  }
}
