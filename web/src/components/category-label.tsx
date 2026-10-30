import {
  Bike,
  Bus,
  CarFront,
  CircleHelp,
  Scan,
  PersonStanding,
  Truck,
} from "lucide-react";
import type { DisplayCategory } from "@/lib/classification";
const icons = {
  Person: PersonStanding,
  Car: CarFront,
  Van: Truck,
  Truck,
  Bus,
  Motorcycle: Bike,
  Bicycle: Bike,
  "Motor vehicle": Scan,
  "Non-motor vehicle": Bike,
  Unknown: CircleHelp,
};
export function CategoryLabel({ category }: { category: DisplayCategory }) {
  const Icon = icons[category];
  return (
    <span className="inline-flex items-center gap-1.5">
      <Icon className="size-3.5 shrink-0 text-primary" />
      {category}
    </span>
  );
}
