import tap from "tap";
import JsonParser from "../src/jsonparse";

const { test } = tap;

test("arrays", async (t) => {
  const values = [
    "[]",
    "[0,1,-1]",
    "[1.0,1.1,-1.1,-1.0][-1][-0.1]",
    "[6.02e23, 6.02e+23, 6.02e-23, 0e23]",
    "[7161093205057351174]",
  ];

  const expected = [
    [[], []],
    [[0], 0],
    [[1], 1],
    [[2], -1],
    [[], [0, 1, -1]],
    [[0], 1],
    [[1], 1.1],
    [[2], -1.1],
    [[3], -1],
    [[], [1, 1.1, -1.1, -1]],
    [[0], -1],
    [[], [-1]],
    [[0], -0.1],
    [[], [-0.1]],
    [[0], 6.02e+23],
    [[1], 6.02e+23],
    [[2], 6.02e-23],
    [[3], 0e23],
    [[], [6.02e+23, 6.02e+23, 6.02e-23, 0e23]],
    [[0], "7161093205057351174"],
    [[], ["7161093205057351174"]],
  ];

  t.plan(expected.length);

  const p = new JsonParser();
  p.onValue = async (value, key, parent, stack) => {
    const keys = stack
      .slice(1)
      .map((item) => item.key)
      .concat(key !== undefined ? key : []);

    t.deepEqual(
      [keys, value],
      expected.shift(),
    );
  };

  for (const str of values) {
    await p.write(str);
  }
});

test("fail on invalid values", async (t) => {
  const values = [
    "[,",
    "[1, eer]",
    "[1,]",
    "[1;",
    "[1}",
  ];
  t.plan(values.length);

  for (const str of values) {
    const p = new JsonParser();
    try {
      await p.write(str);
      t.fail(`Expected to fail on value "${str}"`);
    } catch (e) {
      t.pass();
    }
  }
});
