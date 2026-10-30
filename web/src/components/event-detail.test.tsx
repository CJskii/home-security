import { afterEach, expect, it, vi } from "vitest";
import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { eventSchema, type SecurityEvent } from "@/lib/contracts";
import { EventDetail } from "./event-detail";
vi.mock("./event-media", () => ({ EventMedia: () => <div>Original media</div> }));
afterEach(cleanup);
const eventId = "17b01e57-cc3d-4db5-9bdd-f7d89e8149bb";
const personId = "27b01e57-cc3d-4db5-9bdd-f7d89e8149bb";
const alarmId = "37b01e57-cc3d-4db5-9bdd-f7d89e8149bb";
const vehicleId = "47b01e57-cc3d-4db5-9bdd-f7d89e8149bb";
const warning = "Generated description withheld: unsupported wording or attribute evidence.";
function fixture(): SecurityEvent {
  const field = {basis:"direct_visual", confidence:70, evidenceImages:[2], uncertainty:null};
  const person = {id:personId, category:"person", sourceList:"StructureInfo.ObjInfo.PersonInfoList", sourceIdentifiers:{PersonID:1448}, sourceOrdinal:0, notificationId:"57b01e57-cc3d-4db5-9bdd-f7d89e8149bb", images:{cropId:personId, fullFrameId:null}, rectangle:null,
    analysis:{shortDescription:"A person appears to be walking in a jacket and trousers.", observedType:"person", verification:"uncertain", actions:["walking"], evidenceImages:[1,2], person:{upperClothing:"jacket", lowerClothing:"trousers", upperColor:null, lowerColor:null, outerwear:null, bags:[], headwear:null, carriedObjects:[]}, vehicle:null, relationship:{kind:"beside", object:"vehicle"}, uncertainties:[warning], attributeEvidence:{upperClothing:field,lowerClothing:field,upperColor:{basis:"unknown",confidence:null,evidenceImages:[],uncertainty:"Colour is unclear."}}, diagnostics:[{field:"upperColor",code:"model_omitted"},{field:"shortDescription",code:"description_rule_failure",rules:["unqualified_action"]}]}};
  return eventSchema.parse({id:eventId,camera:"camera_1",nvrChannel:1,alarmType:"cross_line",timestamp:{value:"2026-10-19T19:07:32Z",source:"ALARM_REPORTED_AT"},categories:["person","motor_vehicle"],processing:{status:"COMPLETE",reason:"ai_complete"},
    images:[{id:personId,type:2,url:`/api/events/${eventId}/images/${personId}`,width:64,height:128,availability:{state:"VERIFIED"},capturedAt:null}],
    objects:[{...person,id:alarmId,sourceList:"RelatedObjects.ObjectList",sourceIdentifiers:{ObjectID:1448},images:{cropId:null,fullFrameId:null},analysis:null},person,{...person,id:vehicleId,category:"motor_vehicle",sourceList:"StructureInfo.ObjInfo.VehicleInfoList",sourceIdentifiers:{ID:1450},images:{cropId:null,fullFrameId:null},analysis:{...person.analysis,shortDescription:"A white van is visible.",observedType:"motor_vehicle",person:null,vehicle:{vehicleType:"van",color:"white",make:null,model:null},actions:["visible"],relationship:null}}],
    analysis:{shortDescription:"Duplicated aggregate summary",uncertainties:[warning],model:"vision",promptVersion:4,schemaVersion:3},truncated:{images:false,objects:false}});
}
function mount(event = fixture()) {
  const client=new QueryClient({defaultOptions:{queries:{staleTime:Infinity,retry:false}}});
  render(<QueryClientProvider client={client}><EventDetail id={eventId} initial={event} close={()=>{}} /></QueryClientProvider>);
  return client;
}
it("renders populated per-object attributes, explicit relationships and distinct NVR/AI labels",()=>{
  const client=mount();
  expect(screen.getByText("A person appears to be walking in a jacket and trousers.")).toBeTruthy();
  expect(screen.getByText("A white van is visible.")).toBeTruthy();
  expect(screen.queryByText("Duplicated aggregate summary")).toBeNull();
  expect(screen.getByText(/Relationship: beside a vehicle/)).toBeTruthy();
  const person=screen.getByRole("region",{name:`NVR observation ${personId}`});
  expect(within(person).getByLabelText("Accepted actions").textContent).toBe("walking");
  expect(within(person).getByText("NVR · person")).toBeTruthy();
  expect(person.querySelectorAll("dd")[0]?.textContent).toBe("jacket");
  expect(within(person).queryByText("Unknown")).toBeNull();
  expect(within(person).queryByText("Not established")).toBeNull();
  expect(within(person).queryByText("outerwear")).toBeNull();
  client.clear();
});
it("groups additional reports without merging IDs and exposes confidence, evidence and technical details",async()=>{
  const client=mount();
  const additional=screen.getByText("Additional NVR source reports (1)").closest("details")!;
  expect(additional.open).toBe(false);
  await userEvent.click(within(additional).getByText("Additional NVR source reports (1)"));
  expect(additional.open).toBe(true);
  expect(within(additional).getByText(/shared physical subject has not been verified/)).toBeTruthy();
  expect(screen.getAllByRole("region",{name:/NVR observation/})).toHaveLength(3);
  const person=screen.getByRole("region",{name:`NVR observation ${personId}`});
  const details=within(person).getByText("Confidence, evidence and uncertainty").closest("details")!;
  expect(details.open).toBe(false);
  await userEvent.click(within(person).getByText("Confidence, evidence and uncertainty"));
  expect(details.open).toBe(true);
  expect(within(details).getAllByText(/70% model confidence/)).toHaveLength(2);
  expect(within(details).getByText("Object evidence: 1, 2")).toBeTruthy();
  expect(within(details).getByText("upper color · model omitted")).toBeTruthy();
  expect(within(details).getByText(/description rule failure · unqualified action/)).toBeTruthy();
  expect(screen.getAllByText(warning)).toHaveLength(1);
  expect(screen.getAllByText("Colour is unclear.")).toHaveLength(1);
  await userEvent.click(within(person).getByText("Technical source details"));
  expect(within(person).getByText(personId)).toBeTruthy();
  expect(within(person).getByText("PersonID")).toBeTruthy();
  expect(within(additional).getByText(alarmId)).toBeTruthy();
  client.clear();
});
it("reads historical analyses without new optional fields and never infers a relationship from prose",()=>{
  const event=fixture();
  for(const object of event.objects)if(object.analysis){delete object.analysis.diagnostics;delete object.analysis.relationship;delete object.analysis.evidenceImages;object.analysis.shortDescription="A person is standing near a bin.";}
  const parsed=eventSchema.parse(event),client=mount(parsed);
  expect(screen.queryByText(/^Relationship:/)).toBeNull();
  expect(screen.getAllByText("A person is standing near a bin.")).toHaveLength(2);
  client.clear();
});
it("keeps source-only observations prominent when neither media nor analysis exists",()=>{
  const event=fixture();event.analysis=null;
  for(const object of event.objects){object.analysis=null;object.images={cropId:null,fullFrameId:null};}
  const client=mount(event);
  expect(screen.queryByText(/Additional NVR source reports/)).toBeNull();
  expect(screen.getAllByRole("region",{name:/NVR observation/})).toHaveLength(3);
  client.clear();
});
