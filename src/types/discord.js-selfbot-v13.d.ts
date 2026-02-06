declare module "discord.js-selfbot-v13" {
  export class Client {
    constructor(options?: any);
    passLogin(email: string, password: string): Promise<string>;
    token?: string;
    destroy(): Promise<void>;
  }
}
