import { constantHashable, IMerkleTree, MerkleTree } from '../lib/util/merkle';

test('tree serialization and deserialization', async () => {
  const original = new MerkleTree({
    foo: constantHashable('asdf'),
    bar: new MerkleTree({
      xyz: constantHashable('xyz'),
      qwe: constantHashable('qwe'),
    }),
  });

  const reconstructed = await MerkleTree.deserialize(await MerkleTree.serialize(original));

  expect(await reconstructed.hash()).toEqual(await reconstructed.hash());
});

test('tree serialization of promised elements', async () => {
  const foo: IMerkleTree = {
    hash: () => MerkleTree.hashTree(foo),
    elements: Promise.resolve({
      subelement: constantHashable('xyz'),
    }),
  };
  const original = new MerkleTree({ foo });
  const serialized = await MerkleTree.serialize(original);

  expect(serialized).toEqual(expect.objectContaining({
    elements: {
      foo: expect.objectContaining({
        elements: {
          subelement: 'xyz',
        },
      }),
    },
  }));

  const reconstructed = await MerkleTree.deserialize(serialized);
  expect(await reconstructed.hash()).toEqual(await reconstructed.hash());
});