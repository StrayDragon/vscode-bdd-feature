/**
 * cucumber-js style step definitions (fixtures for the unit tests).
 * Also demonstrates playwright-bdd's createBdd() shape in comments.
 */
import { Given, When, Then } from '@cucumber/cucumber';

Given('I have entered {int} into the calculator', function (value: number) {
  this.value = value;
});

When('I press {word}', function (key: string) {
  this.key = key;
});

Then('the result should be {int} on the screen', function (expected: number) {
  if (this.value !== expected) {
    throw new Error(`expected ${expected}, got ${this.value}`);
  }
});

// playwright-bdd equivalent shape:
//   export const { Given, When, Then } = createBdd(test);
//   Then('the result should be {int} on the screen', async ({}, expected) => {});
