import { constantHashable, hashOf, IHashableElements, MerkleTree } from '../lib/util/merkle';

test('tree serialization and deserialization', async () => {
  const original = new MerkleTree({
    foo: constantHashable('asdf'),
    bar: new MerkleTree({
      xyz: constantHashable('xyz'),
      qwe: constantHashable('qwe'),
    }),
  });

  const reconstructed = await MerkleTree.deserialize(await MerkleTree.serialize(original));

  expect(await hashOf(reconstructed)).toEqual(await hashOf(reconstructed));
});

test('tree serialization of promised elements', async () => {
  const foo: IHashableElements = {
    hashableElements: Promise.resolve({
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
  expect(await hashOf(reconstructed)).toEqual(await hashOf(reconstructed));
});