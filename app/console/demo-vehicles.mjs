/**
 * Pre-made demonstration vehicles for the intake console's demo picker.
 *
 * Every VIN is fictional and every story is chosen to showcase one behaviour
 * of the system - including the ones that end in refusal, because watching
 * the circuit say no is the product. The `expect` line is shown to the
 * evaluator BEFORE submitting, so the refusals read as the point rather than
 * as bugs.
 *
 * Keys mirror the form's field names so filling is mechanical.
 *
 * SPDX-License-Identifier: Apache-2.0
 */
export const DEMO_VEHICLES = [
    {
        name: '2019 VW Golf 1.5 TSI — clean history, everything proven',
        expect: 'Expect: every step accepted, four green ticks on the verdict page.',
        vin: 'WVWZZZAUZKW912345', registrar: 'kba-flensburg', label: '2019 Golf, silver',
        vehicleCategory: 'M1', fuelType: 'petrol', emissionsClass: 'Euro 6',
        firstRegistrationDate: '2019-03-14', euTypeApprovalNumber: 'e1*2018/858*00147*03',
        fields: { odometerKm: 21_300, accidentCount: 0, ownerCount: 1, writeOffCategory: 0, serviceCount: 1 },
        env: { co2FootprintKgCO2e: 28_400, recycledPlasticPct: 22.0 },
        updates: [
            { odometerKm: 47_800, serviceCount: 2 },
            { odometerKm: 74_150, serviceCount: 3 }
        ],
        prove: { neverWrittenOff: true, noAccidents: true, oneKeeper: true, mileageUnder: 150_000 }
    },
    {
        name: '2022 Tesla Model 3 — BEV with a battery passport link',
        expect: 'Expect: all accepted — note the battery passport ID anchoring as a reference, ' +
            'never a copy of the battery’s own claims.',
        vin: '5YJ3E1EA7NF480123', registrar: 'rdw-veendam', label: '2022 Model 3, white',
        vehicleCategory: 'M1', fuelType: 'bev', emissionsClass: 'n/a',
        firstRegistrationDate: '2022-06-02',
        batteryPassportId: 'BPID-EU-000184-2027', batteryChemistry: 'NMC811',
        fields: { odometerKm: 33_900, accidentCount: 0, ownerCount: 1, writeOffCategory: 0, serviceCount: 2 },
        env: { co2FootprintKgCO2e: 8_600, recycledPlasticPct: 27.5, recycledAluminiumPct: 34.0 },
        updates: [{ odometerKm: 51_200, serviceCount: 3 }],
        prove: { neverWrittenOff: true, noAccidents: true, oneKeeper: true, mileageUnder: 100_000 }
    },
    {
        name: '2016 Audi A4 2.0 TDI — the odometer rollback attempt',
        expect: 'Expect: TWO REFUSALS. The rolled-back service record aborts in-circuit ' +
            '("value decreased"), and the mileage claim fails against the true reading. ' +
            'This one exists to show the integrity rule biting.',
        vin: 'WAUZZZF47GA067890', registrar: 'kba-flensburg', label: '2016 A4, black',
        vehicleCategory: 'M1', fuelType: 'diesel', emissionsClass: 'Euro 6',
        firstRegistrationDate: '2016-09-21',
        fields: { odometerKm: 148_200, accidentCount: 0, ownerCount: 2, writeOffCategory: 0, serviceCount: 6 },
        updates: [
            { odometerKm: 152_600, serviceCount: 7 },
            { odometerKm: 121_000 }                     // the rollback - will be refused
        ],
        prove: { neverWrittenOff: true, noAccidents: true, oneKeeper: false, mileageUnder: 150_000 }
    },
    {
        name: '2018 BMW 320d — written off, seller declines the clean claims',
        expect: 'Expect: accepted, but with no clean-history proofs requested. The verdict page ' +
            'shows "not proven" — absence of proof, never a false tick.',
        vin: 'WBA8E9G50JNU34567', registrar: 'dvla-swansea', label: '2018 320d, grey',
        vehicleCategory: 'M1', fuelType: 'diesel', emissionsClass: 'Euro 6',
        firstRegistrationDate: '2018-01-30',
        fields: { odometerKm: 88_400, accidentCount: 1, ownerCount: 2, writeOffCategory: 2, serviceCount: 4 },
        updates: [{ odometerKm: 103_700, serviceCount: 5 }],
        prove: { neverWrittenOff: false, noAccidents: false, oneKeeper: false, mileageUnder: 200_000 }
    },
    {
        name: '2021 Toyota RAV4 PHEV — plug-in hybrid, second keeper',
        expect: 'Expect: accepted. A PHEV also carries the battery passport link; with two ' +
            'keepers the one-keeper claim is simply not requested.',
        vin: 'JTMB53FV5MD012678', registrar: 'rdw-veendam', label: '2021 RAV4 PHEV, red',
        vehicleCategory: 'M1', fuelType: 'phev', emissionsClass: 'Euro 6e',
        firstRegistrationDate: '2021-04-19',
        batteryPassportId: 'BPID-EU-000377-2027', batteryChemistry: 'LiPo-NMC',
        fields: { odometerKm: 42_650, accidentCount: 0, ownerCount: 2, writeOffCategory: 0, serviceCount: 3 },
        updates: [{ odometerKm: 58_900, serviceCount: 4 }],
        prove: { neverWrittenOff: true, noAccidents: true, oneKeeper: false, mileageUnder: 120_000 }
    },
    {
        name: '2024 Ford Transit — brand new, never registered',
        expect: 'Expect: accepted with keepers = 0 — "new versus second-hand" is exactly what ' +
            'the keeper count answers.',
        vin: 'WF0EXXTTREPY45012', registrar: 'dvla-swansea', label: 'New Transit, white',
        vehicleCategory: 'N1', fuelType: 'diesel', emissionsClass: 'Euro 6e',
        firstRegistrationDate: '',
        fields: { odometerKm: 40, accidentCount: 0, ownerCount: 0, writeOffCategory: 0, serviceCount: 0 },
        updates: [],
        prove: { neverWrittenOff: true, noAccidents: true, oneKeeper: true, mileageUnder: 1_000 }
    }
];
