/**
 * Pre-made demonstration vehicles for the intake console's demo picker.
 *
 * Two groups, split the way the regulation splits the world:
 *
 *   origin 'new'       a passport issued with the vehicle at first placing on
 *                      the market - the mandatory path from September 2032.
 *                      Keepers 0, delivery mileage, no history yet.
 *   origin 'retrofit'  a vehicle produced before the regulation applies; the
 *                      passport is added to the existing fleet, history and
 *                      all.
 *
 * Every VIN is fictional and every story is chosen to showcase one behaviour
 * of the system - including the ones that end in refusal, because watching
 * the circuit say no is the product. The `expect` line is shown BEFORE
 * submitting, so refusals read as the point rather than as bugs. All values
 * are sample data under the console's DEMO banner; none describe a real
 * vehicle.
 *
 * SPDX-License-Identifier: Apache-2.0
 */

/** A new vehicle: keepers 0, delivery mileage, claims that hold by construction. */
const newCar = (name, vin, registrar, label, opts = {}) => ({
    name, vin, registrar, label,
    origin: 'new',
    expect: opts.expect ??
        'Expect: all accepted. A new vehicle proves its four claims by construction - keepers 0, nothing on the record yet.',
    vehicleCategory: opts.category ?? 'M1',
    fuelType: opts.fuel,
    emissionsClass: opts.emissions ?? (['bev', 'h2'].includes(opts.fuel) ? 'n/a' : 'Euro 6e'),
    firstRegistrationDate: '',
    euTypeApprovalNumber: opts.approval ?? '',
    batteryPassportId: opts.bpid ?? '',
    batteryChemistry: opts.chem ?? '',
    fields: {
        odometerKm: opts.km ?? 15, accidentCount: 0, ownerCount: 0,
        writeOffCategory: 0, serviceCount: 0
    },
    env: opts.env ?? {},
    updates: [],
    prove: { neverWrittenOff: true, noAccidents: true, oneKeeper: true, mileageUnder: 500 }
});

export const DEMO_VEHICLES = [

    // ------------------------------------------------ new vehicles (20)
    // Battery electric
    newCar('VW ID.7 Pro — BEV', 'WVGZZZE2ZSP004821', 'kba-flensburg', 'ID.7 Pro, moonstone', {
        fuel: 'bev', bpid: 'BPID-EU-001204-2027', chem: 'NMC811',
        env: { co2FootprintKgCO2e: 9200, recycledPlasticPct: 28.0, recycledAluminiumPct: 36.5 }
    }),
    newCar('Tesla Model Y — BEV', '5YJYGDEF3SF208934', 'rdw-veendam', 'Model Y, midnight silver', {
        fuel: 'bev', bpid: 'BPID-EU-001377-2027', chem: 'LFP', km: 22
    }),
    newCar('BMW i4 eDrive40 — BEV', 'WBY73AW090FS55127', 'kba-flensburg', 'i4 eDrive40, portimao blue', {
        fuel: 'bev', bpid: 'BPID-EU-001445-2027', chem: 'NMC721',
        env: { co2FootprintKgCO2e: 10100, recycledSteelPct: 33.0 }
    }),
    newCar('Renault 5 E-Tech — BEV', 'VF1RSZE0X53112480', 'utac-montlhery', 'R5 E-Tech, pop yellow', {
        fuel: 'bev', bpid: 'BPID-EU-001502-2027', chem: 'NMC622', km: 9
    }),
    newCar('Škoda Elroq 85 — BEV', 'TMBJJ9NY8S7031264', 'kba-flensburg', 'Elroq 85, timiano green', {
        fuel: 'bev', bpid: 'BPID-EU-001618-2027', chem: 'NMC811'
    }),
    newCar('Hyundai Ioniq 6 — BEV', 'KMHM34AC1SA047719', 'rdw-veendam', 'Ioniq 6, gravity gold', {
        fuel: 'bev', bpid: 'BPID-EU-001733-2027', chem: 'NMC811', km: 31
    }),
    newCar('Kia EV3 Long Range — BEV', 'KNACC81GFS5120358', 'rdw-veendam', 'EV3, aventurine green', {
        fuel: 'bev', bpid: 'BPID-EU-001799-2027', chem: 'NMC622',
        env: { recycledPlasticPct: 31.5 }
    }),
    newCar('Polestar 4 — BEV', 'YSMYKEKK6SB110472', 'transportstyrelsen-se', 'Polestar 4, snow', {
        fuel: 'bev', bpid: 'BPID-EU-001846-2027', chem: 'NMC811', km: 18
    }),
    newCar('Fiat 500e — BEV', 'ZFAEFAB19SX901253', 'mit-roma', '500e, rose gold', {
        fuel: 'bev', bpid: 'BPID-EU-001920-2027', chem: 'NMC532', km: 7
    }),
    newCar('Volvo EX30 — BEV', 'YV1XZEHV1S2408166', 'transportstyrelsen-se', 'EX30, cloud blue', {
        fuel: 'bev', bpid: 'BPID-EU-002051-2027', chem: 'LFP',
        env: { co2FootprintKgCO2e: 7800, recycledAluminiumPct: 41.0 }
    }),

    // Plug-in hybrid
    newCar('Ford Kuga 2.5 PHEV', 'WF0FXXWPMHSK30917', 'dvla-swansea', 'Kuga PHEV, magnetic', {
        fuel: 'phev', bpid: 'BPID-EU-002140-2027', chem: 'NMC622', emissions: 'Euro 6e'
    }),
    newCar('Mercedes GLC 300e — PHEV', 'W1NKM8HB3SF442071', 'kba-flensburg', 'GLC 300e, obsidian', {
        fuel: 'phev', bpid: 'BPID-EU-002218-2027', chem: 'NMC721', km: 26
    }),
    newCar('BMW X1 xDrive25e — PHEV', 'WBX13EF050S994382', 'kba-flensburg', 'X1 25e, alpine white', {
        fuel: 'phev', bpid: 'BPID-EU-002377-2027', chem: 'NMC622'
    }),

    // Hybrid
    newCar('Toyota Corolla 1.8 HEV', 'SB1KE3BE10E284951', 'dvla-swansea', 'Corolla hybrid, platinum', {
        fuel: 'hev', emissions: 'Euro 6e', km: 12
    }),
    newCar('Honda CR-V e:HEV', 'SHHRS4850SU203174', 'dvla-swansea', 'CR-V e:HEV, canyon river blue', {
        fuel: 'hev', emissions: 'Euro 6e'
    }),

    // Petrol
    newCar('VW Golf 1.5 eTSI — petrol', 'WVWZZZCD2SW387105', 'kba-flensburg', 'Golf eTSI, kings red', {
        fuel: 'petrol', emissions: 'Euro 6e', approval: 'e1*2018/858*00147*11',
        env: { recycledPlasticPct: 24.0 }
    }),
    newCar('Toyota Yaris 1.5 — petrol', 'VNKKD3B360A417296', 'utac-montlhery', 'Yaris, glacier white', {
        fuel: 'petrol', emissions: 'Euro 6e', km: 11
    }),

    // Diesel
    newCar('VW Passat 2.0 TDI — diesel', 'WVWZZZ3CZSE221840', 'kba-flensburg', 'Passat TDI, deep black', {
        fuel: 'diesel', emissions: 'Euro 6e'
    }),
    newCar('Toyota Hilux 2.8 D — diesel', 'AHTKB8CD402617935', 'natis-pretoria', 'Hilux, glacier white', {
        fuel: 'diesel', emissions: 'Euro 6e', category: 'N1', km: 43
    }),

    // Hydrogen
    newCar('Toyota Mirai — hydrogen', 'JTDAAAAA502041187', 'rdw-veendam', 'Mirai, force blue', {
        fuel: 'h2', km: 19,
        expect: 'Expect: all accepted. Fuel cell vehicle - no traction battery passport, and its absence is anchored salted, indistinguishable from presence.'
    }),

    // ------------------------------------------------ existing fleet (6)
    {
        name: '2019 VW Golf 1.5 TSI — clean history, everything proven',
        origin: 'retrofit',
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
        origin: 'retrofit',
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
        origin: 'retrofit',
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
        origin: 'retrofit',
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
        origin: 'retrofit',
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
        name: '2024 Ford Transit — sold new with its passport',
        origin: 'new',
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
