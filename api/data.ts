import { handleUserData } from "../lib/userDataApi.js";

export default function handler(req: any, res: any) {
  return handleUserData(req, res);
}
