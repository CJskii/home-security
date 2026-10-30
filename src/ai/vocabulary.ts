import { z } from 'zod';
export const facingDirectionSchema = z.enum(['towards_camera', 'away_from_camera', 'sideways', 'unknown']);
